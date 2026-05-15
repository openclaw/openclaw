import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import path from "node:path";
import type {
  DocumentExtractedImage,
  DocumentExtractionRequest,
  DocumentExtractionResult,
  DocumentExtractorPlugin,
} from "openclaw/plugin-sdk/document-extractor";
import type * as PdfJsLegacy from "pdfjs-dist/legacy/build/pdf.mjs";

type CanvasLike = {
  toBuffer(type: "image/png"): Buffer;
};

type CanvasModule = {
  createCanvas(width: number, height: number): CanvasLike;
};

type PdfTextItem = {
  str: string;
};

type PdfTextContent = {
  items: Array<PdfTextItem | object>;
};

type PdfViewport = {
  width: number;
  height: number;
};

type PdfPage = {
  getTextContent(): Promise<PdfTextContent>;
  getViewport(params: { scale: number }): PdfViewport;
  render(params: { canvas: unknown; viewport: PdfViewport }): { promise: Promise<void> };
};

type PdfDocument = {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
};

type PdfJsModule = typeof PdfJsLegacy;

const CANVAS_MODULE = "@napi-rs/canvas";
const PDFJS_MODULE = "pdfjs-dist/legacy/build/pdf.mjs";
const MAX_EXTRACTED_TEXT_CHARS = 200_000;
const MAX_RENDER_DIMENSION = 10_000;
const require = createRequire(import.meta.url);

let canvasModulePromise: Promise<CanvasModule> | null = null;
let pdftoppmAvailablePromise: Promise<boolean> | null = null;
let pdfJsModulePromise: Promise<PdfJsModule> | null = null;
let pdfJsStandardFontDataPath: string | null = null;

async function loadCanvasModule(): Promise<CanvasModule> {
  if (!canvasModulePromise) {
    canvasModulePromise = (import(CANVAS_MODULE) as Promise<CanvasModule>).catch((err) => {
      canvasModulePromise = null;
      throw new Error("Optional dependency @napi-rs/canvas is required for PDF image extraction", {
        cause: err,
      });
    });
  }
  return canvasModulePromise;
}

async function loadPdfJsModule(): Promise<PdfJsModule> {
  if (!pdfJsModulePromise) {
    pdfJsModulePromise = (import(PDFJS_MODULE) as Promise<PdfJsModule>).catch((err) => {
      pdfJsModulePromise = null;
      throw new Error("Optional dependency pdfjs-dist is required for PDF extraction", {
        cause: err,
      });
    });
  }
  return pdfJsModulePromise;
}

function resolvePdfJsStandardFontDataPath(): string {
  if (!pdfJsStandardFontDataPath) {
    const pdfJsPackageJsonPath = require.resolve("pdfjs-dist/package.json");
    pdfJsStandardFontDataPath =
      path.join(path.dirname(pdfJsPackageJsonPath), "standard_fonts") + "/";
  }
  return pdfJsStandardFontDataPath;
}

function isPdftoppmAvailable(): Promise<boolean> {
  if (!pdftoppmAvailablePromise) {
    pdftoppmAvailablePromise = new Promise<boolean>((resolve) => {
      const child = spawn("pdftoppm", ["-v"], { timeout: 5000, stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("close", () => resolve(true));
    });
  }
  return pdftoppmAvailablePromise;
}

async function renderPageWithPdftoppm(
  buffer: Buffer,
  pageNumber: number,
  targetWidth: number,
  targetHeight: number,
): Promise<Buffer | null> {
  const tempDir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "oc-pdf-"));
  await fs.chmod(tempDir, 0o700);
  try {
    const pdfPath = path.join(tempDir, "input.pdf");
    const outPrefix = path.join(tempDir, "page");
    await fs.writeFile(pdfPath, buffer);
    // Bound the output to the planned width/height so the post-fix pixel
    // count never exceeds `plan.pixels`. `-scale-to-x` / `-scale-to-y`
    // force the renderer to honor the budget regardless of source page
    // size or DPI heuristics; without this clamp `pdftoppm` could
    // produce a much larger PNG than the plan allowed.  See #75358.
    const clampedWidth = Math.max(1, Math.floor(targetWidth));
    const clampedHeight = Math.max(1, Math.floor(targetHeight));
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "pdftoppm",
        [
          "-png",
          "-f",
          String(pageNumber),
          "-l",
          String(pageNumber),
          "-scale-to-x",
          String(clampedWidth),
          "-scale-to-y",
          String(clampedHeight),
          pdfPath,
          outPrefix,
        ],
        { timeout: 30000, stdio: "ignore" },
      );
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`pdftoppm exited with code ${String(code)}`));
        }
      });
    });
    const files = await fs.readdir(tempDir);
    const pngFile = files.find((f) => f.endsWith(".png"));
    if (!pngFile) {
      return null;
    }
    return await fs.readFile(path.join(tempDir, pngFile));
  } catch {
    return null;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function appendTextWithinLimit(parts: string[], pageText: string, currentLength: number): number {
  if (!pageText) {
    return currentLength;
  }
  const remaining = MAX_EXTRACTED_TEXT_CHARS - currentLength;
  if (remaining <= 0) {
    return currentLength;
  }
  const nextText = pageText.length > remaining ? pageText.slice(0, remaining) : pageText;
  parts.push(nextText);
  return currentLength + nextText.length;
}

function resolveRenderPlan(
  viewport: PdfViewport,
  remainingPixels: number,
): { scale: number; width: number; height: number; pixels: number } | null {
  if (
    remainingPixels <= 0 ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return null;
  }

  const pagePixels = Math.max(1, viewport.width * viewport.height);
  const maxScale = Math.min(
    1,
    Math.sqrt(remainingPixels / pagePixels),
    MAX_RENDER_DIMENSION / viewport.width,
    MAX_RENDER_DIMENSION / viewport.height,
  );
  if (!Number.isFinite(maxScale) || maxScale <= 0) {
    return null;
  }

  let best: { scale: number; width: number; height: number; pixels: number } | null = null;
  let low = 0;
  let high = maxScale;
  for (let i = 0; i < 32; i += 1) {
    const scale = (low + high) / 2;
    const width = Math.max(1, Math.ceil(viewport.width * scale));
    const height = Math.max(1, Math.ceil(viewport.height * scale));
    const pixels = width * height;
    if (
      width <= MAX_RENDER_DIMENSION &&
      height <= MAX_RENDER_DIMENSION &&
      pixels <= remainingPixels
    ) {
      best = { scale, width, height, pixels };
      low = scale;
    } else {
      high = scale;
    }
  }
  return best;
}

async function extractPdfContent(
  request: DocumentExtractionRequest,
): Promise<DocumentExtractionResult> {
  const pdfJsModule = await loadPdfJsModule();
  const pdf = (await pdfJsModule.getDocument({
    data: new Uint8Array(request.buffer),
    disableWorker: true,
    standardFontDataUrl: resolvePdfJsStandardFontDataPath(),
  }).promise) as PdfDocument;

  const effectivePages: number[] = request.pageNumbers
    ? request.pageNumbers.filter((p) => p >= 1 && p <= pdf.numPages).slice(0, request.maxPages)
    : Array.from({ length: Math.min(pdf.numPages, request.maxPages) }, (_, i) => i + 1);

  const textParts: string[] = [];
  let extractedTextLength = 0;
  for (const pageNum of effectivePages) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => ("str" in item ? item.str : ""))
      .filter(Boolean)
      .join(" ");
    if (pageText) {
      extractedTextLength = appendTextWithinLimit(textParts, pageText, extractedTextLength);
      if (extractedTextLength >= MAX_EXTRACTED_TEXT_CHARS) {
        break;
      }
    }
  }

  const text = textParts.join("\n\n");
  if (text.trim().length >= request.minTextChars) {
    return { text, images: [] };
  }

  let canvasModule: CanvasModule;
  try {
    canvasModule = await loadCanvasModule();
  } catch (err) {
    if (await isPdftoppmAvailable()) {
      const images: DocumentExtractedImage[] = [];
      let remainingPixels = Math.max(1, Math.floor(request.maxPixels));
      for (const pageNum of effectivePages) {
        if (remainingPixels <= 0) {
          break;
        }
        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1 });
        const plan = resolveRenderPlan(viewport, remainingPixels);
        if (!plan) {
          break;
        }
        const png = await renderPageWithPdftoppm(
          Buffer.from(request.buffer),
          pageNum,
          plan.width,
          plan.height,
        );
        if (png) {
          images.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
          remainingPixels -= plan.pixels;
        }
      }
      return { text, images };
    }
    request.onImageExtractionError?.(err);
    return { text, images: [] };
  }

  const images: DocumentExtractedImage[] = [];
  let remainingPixels = Math.max(1, Math.floor(request.maxPixels));

  for (const pageNum of effectivePages) {
    if (remainingPixels <= 0) {
      break;
    }
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const plan = resolveRenderPlan(viewport, remainingPixels);
    if (!plan) {
      break;
    }
    const scaled = page.getViewport({ scale: plan.scale });
    const canvas = canvasModule.createCanvas(plan.width, plan.height);
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport: scaled,
    }).promise;
    const png = canvas.toBuffer("image/png");
    images.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
    remainingPixels -= plan.pixels;
  }

  return { text, images };
}

export function createPdfDocumentExtractor(): DocumentExtractorPlugin {
  return {
    id: "pdf",
    label: "PDF",
    mimeTypes: ["application/pdf"],
    autoDetectOrder: 10,
    extract: extractPdfContent,
  };
}
