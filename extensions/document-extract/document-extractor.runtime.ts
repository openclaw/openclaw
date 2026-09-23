// Document Extract plugin module implements document extractor behavior.
import type { PdfDocument, PdfEngine, RenderOptions } from "clawpdf";
import type {
  DocumentExtractedImage,
  DocumentExtractionRequest,
  DocumentExtractionResult,
} from "openclaw/plugin-sdk/document-extractor";
import type { WorkerTaskControl } from "openclaw/plugin-sdk/worker-task-server";

const MAX_EXTRACTED_TEXT_CHARS = 200_000;
const MAX_RENDER_DIMENSION = 10_000;

let pdfEnginePromise: Promise<PdfEngine> | null = null;

async function loadPdfEngine(): Promise<PdfEngine> {
  if (!pdfEnginePromise) {
    pdfEnginePromise = import("clawpdf")
      .then(({ createEngine }) => createEngine())
      .catch((err: unknown) => {
        pdfEnginePromise = null;
        throw new Error("Dependency clawpdf is required for PDF extraction", {
          cause: err,
        });
      });
  }
  return pdfEnginePromise;
}

function toDocumentImage(bytes: Uint8Array): DocumentExtractedImage {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  return { type: "image", data, mimeType: "image/png" };
}

function pageRenderOptions(width: number, height: number, maxPixels: number): RenderOptions | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const defaultWidth = Math.ceil(width * (96 / 72));
  const defaultHeight = Math.ceil(height * (96 / 72));
  if (
    defaultWidth <= MAX_RENDER_DIMENSION &&
    defaultHeight <= MAX_RENDER_DIMENSION &&
    defaultWidth * defaultHeight <= maxPixels
  ) {
    return { dpi: 96, forms: true };
  }

  const landscape = width >= height;
  const longer = landscape ? width : height;
  const shorter = landscape ? height : width;
  let low = 1;
  let high = Math.min(MAX_RENDER_DIMENSION, Math.ceil(longer * (96 / 72)));
  let size = 1;
  // Search integer output dimensions, including render()'s upward rounding of
  // the other edge. The 10,000-pixel edge cap bounds this to 14 iterations.
  while (low <= high) {
    const candidate = Math.floor((low + high) / 2);
    const other = Math.max(1, Math.ceil(shorter * (candidate / longer)));
    if (candidate * other <= maxPixels) {
      size = candidate;
      low = candidate + 1;
    } else {
      high = candidate - 1;
    }
  }
  return landscape ? { width: size, forms: true } : { height: size, forms: true };
}

function isPdfPasswordError(err: unknown): boolean {
  return err !== null && typeof err === "object" && "code" in err && err.code === "password";
}

async function openPdfDocument(params: {
  engine: PdfEngine;
  input: Uint8Array;
  password?: string;
}): Promise<PdfDocument> {
  try {
    return params.password
      ? await params.engine.open(params.input, { password: params.password })
      : await params.engine.open(params.input);
  } catch (err) {
    if (isPdfPasswordError(err)) {
      throw new Error("PDF requires a password or password is incorrect.", { cause: err });
    }
    throw err;
  }
}

export async function extractPdfContent(
  request: DocumentExtractionRequest,
  control: WorkerTaskControl,
): Promise<DocumentExtractionResult> {
  const engine = await loadPdfEngine();
  control.throwIfCancelled();
  const pdf = await openPdfDocument({
    engine,
    input: request.buffer,
    ...(request.password ? { password: request.password } : {}),
  });
  try {
    control.throwIfCancelled();
    const pages = request.pageNumbers
      ? request.pageNumbers
          .filter((p) => Number.isInteger(p) && p >= 1 && p <= pdf.pageCount)
          .slice(0, request.maxPages)
      : undefined;
    if (request.pageNumbers?.length && pages?.length === 0) {
      throw new Error(`No requested PDF pages exist in this ${pdf.pageCount}-page document.`);
    }
    const selectedPages =
      pages ?? Array.from({ length: Math.min(pdf.pageCount, request.maxPages) }, (_, i) => i + 1);
    const imagePages: number[] = [];
    let text = "";
    for (const pageNumber of selectedPages) {
      control.throwIfCancelled();
      const pageText = pdf.page(pageNumber).text();
      if (pageText.trim().length < request.minTextChars) {
        imagePages.push(pageNumber);
      }
      const separator = text ? "\n\n" : "";
      const remaining = MAX_EXTRACTED_TEXT_CHARS - text.length - separator.length;
      if (pageText && remaining > 0) {
        text += separator + pageText.slice(0, remaining);
      }
    }
    control.throwIfCancelled();
    if (imagePages.length === 0) {
      return { text, images: [] };
    }

    // Share the aggregate pixel budget only across pages needing image fallback.
    try {
      const { encodePng, PdfError } = await import("clawpdf");
      const images: DocumentExtractedImage[] = [];
      let remainingPixels = request.maxPixels;
      for (const [index, pageNumber] of imagePages.entries()) {
        control.throwIfCancelled();
        if (remainingPixels <= 0) {
          break;
        }
        const pagesRemaining = imagePages.length - index;
        const maxPixelsPerPage = Math.max(1, Math.ceil(remainingPixels / pagesRemaining));
        if (!Number.isFinite(maxPixelsPerPage)) {
          throw new PdfError("budget", "maxPixels must be a finite positive number");
        }
        const page = pdf.page(pageNumber);
        const options = pageRenderOptions(page.width, page.height, maxPixelsPerPage);
        if (!options) {
          continue;
        }
        const rendered = page.render(options);
        control.throwIfCancelled();
        // Node cannot safely terminate a worker inside zlib initialization.
        // Fence one PNG encode; PDFium rendering remains immediately cancellable.
        const bytes = await control.runNativeSection(() =>
          encodePng(rendered.rgba, { width: rendered.width, height: rendered.height }),
        );
        control.throwIfCancelled();
        images.push(toDocumentImage(bytes));
        remainingPixels -= rendered.width * rendered.height;
      }
      return { text, images };
    } catch (err) {
      control.throwIfCancelled();
      request.onImageExtractionError?.(err);
      if (!text.trim()) {
        throw new Error("PDF image extraction failed with no extractable text.", { cause: err });
      }
      return { text, images: [] };
    }
  } finally {
    pdf.destroy();
  }
}
