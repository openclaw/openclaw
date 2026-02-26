import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { extractArabicPdfText } from "./pdf-extractor.js";

const execFile = promisify(execFileCb);

type SourceExtractionMode = "native" | "llm_ocr_fallback";

const LEGAL_PROOFREADER_OCR_MODEL = "openai-codex/gpt-5.2";

export type SourceExtractionResult = {
  pages: string[];
  articleTexts: Record<string, string>;
  mode: SourceExtractionMode;
  diagnostics: string[];
};

function countArabicChars(text: string): number {
  const matches = text.match(/[\u0600-\u06FF]/g);
  return matches?.length ?? 0;
}

function hasUsableNativeExtraction(pages: string[], articleTexts: Record<string, string>): boolean {
  const pageText = pages.join("\n");
  const arabicChars = countArabicChars(pageText);
  if (arabicChars < 200) {
    return false;
  }

  if (Object.keys(articleTexts).length > 0) {
    return true;
  }

  // If we have enough Arabic chars but no headings, keep native to avoid expensive fallback loops.
  return arabicChars >= 1000;
}

function normalizeArabicArticleToken(token: string): string {
  const trimmed = token.trim().replace(/[()]/g, "");
  if (!trimmed) {
    return "";
  }
  const digits = trimmed.match(/\d+/)?.[0];
  if (digits) {
    return digits;
  }
  return trimmed;
}

function buildArticleMapFromPages(pages: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  let currentArticle = "";

  for (const pageText of pages) {
    const lines = pageText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      const m = line.match(/^المادة\s+(.+)$/u);
      if (m?.[1]) {
        const token = normalizeArabicArticleToken((m[1] ?? "").split(/\s+/u)[0] ?? "");
        if (token) {
          currentArticle = token;
          out[currentArticle] = out[currentArticle] ? `${out[currentArticle]}\n${line}` : line;
          continue;
        }
      }

      if (currentArticle) {
        out[currentArticle] = out[currentArticle] ? `${out[currentArticle]}\n${line}` : line;
      }
    }
  }

  return out;
}

function extractJsonObject(text: string): string | null {
  const tagged = text.match(/<ocr>\s*([\s\S]*?)\s*<\/ocr>/i);
  if (tagged?.[1]) {
    return tagged[1].trim();
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return null;
  }
  return text.slice(firstBrace, lastBrace + 1);
}

async function renderPdfToPngPages(pdfPath: string, outDir: string): Promise<string[]> {
  const prefix = path.join(outDir, "page");
  await execFile("pdftoppm", ["-png", "-r", "220", pdfPath, prefix], {
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
  });

  const entries = await fs.readdir(outDir);
  const pngs = entries
    .filter((name) => /^page-\d+\.png$/i.test(name))
    .sort((a, b) => {
      const aNum = Number.parseInt(a.match(/(\d+)/)?.[1] ?? "0", 10);
      const bNum = Number.parseInt(b.match(/(\d+)/)?.[1] ?? "0", 10);
      return aNum - bNum;
    })
    .map((name) => path.join(outDir, name));

  return pngs;
}

async function runOcrOnImagePage(params: {
  config: OpenClawConfig;
  imagePath: string;
  pageNo: number;
  runId: string;
}): Promise<string> {
  const { config, imagePath, pageNo, runId } = params;
  const workspaceDir = config.agents?.defaults?.workspace ?? process.cwd();

  const mod = (await import("../../../../src/agents/pi-embedded-runner.js")) as {
    runEmbeddedPiAgent: (args: {
      sessionId: string;
      sessionFile: string;
      workspaceDir: string;
      config?: OpenClawConfig;
      prompt: string;
      timeoutMs: number;
      runId: string;
      provider?: string;
      model?: string;
      disableTools?: boolean;
    }) => Promise<{ payloads?: Array<{ text?: string; isError?: boolean }> }>;
  };

  const [provider, ...modelParts] = LEGAL_PROOFREADER_OCR_MODEL.split("/");
  const model = modelParts.join("/") || undefined;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legal-ocr-"));
  try {
    const sessionFile = path.join(tmpDir, "session.json");
    const prompt = [
      "You are a forensic OCR extractor for Arabic legal documents.",
      "You MUST call the read tool to inspect the provided image file.",
      `Image path: ${imagePath}`,
      "Extract Arabic text exactly as seen. Do NOT translate, summarize, or rewrite.",
      "Preserve article headings, numbers, punctuation, references, and list markers.",
      "If any token is unclear, keep best guess and append [UNCLEAR].",
      `Return ONLY JSON wrapped in <ocr>...</ocr> with shape: {\"page\":${pageNo},\"text\":\"...\",\"confidence\":0.0,\"flags\":[...]}`,
    ].join("\n");

    const result = await mod.runEmbeddedPiAgent({
      sessionId: `legal-proofreader-ocr-${runId}-${pageNo}`,
      sessionFile,
      workspaceDir,
      config,
      prompt,
      timeoutMs: 120_000,
      runId: `${runId}-page-${pageNo}`,
      provider,
      model,
      disableTools: false,
    });

    const text = (result.payloads ?? [])
      .filter((p) => !p.isError)
      .map((p) => p.text ?? "")
      .join("\n")
      .trim();

    if (!text) {
      throw new Error(`Empty OCR response for page ${pageNo}`);
    }

    const payload = extractJsonObject(text);
    if (!payload) {
      throw new Error(`Missing OCR JSON payload for page ${pageNo}`);
    }

    const parsed = JSON.parse(payload) as { text?: unknown };
    const pageText = typeof parsed.text === "string" ? parsed.text : "";
    if (!pageText.trim()) {
      throw new Error(`OCR payload has empty text for page ${pageNo}`);
    }

    return pageText;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function runLlmOcrFallback(params: {
  config: OpenClawConfig;
  sourcePdfPath: string;
  diagnostics: string[];
}): Promise<{ pages: string[]; articleTexts: Record<string, string> }> {
  const { config, sourcePdfPath, diagnostics } = params;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legal-pdf-pages-"));
  try {
    const pageImages = await renderPdfToPngPages(sourcePdfPath, tmpDir);
    if (pageImages.length === 0) {
      throw new Error("No rendered PNG pages found for OCR fallback.");
    }

    diagnostics.push(`LLM OCR fallback triggered on ${pageImages.length} page image(s).`);

    const pages: string[] = [];
    // Keep conservative concurrency for stability and quota pressure.
    for (let i = 0; i < pageImages.length; i += 1) {
      const imagePath = pageImages[i] ?? "";
      if (!imagePath) {
        continue;
      }
      const pageText = await runOcrOnImagePage({
        config,
        imagePath,
        pageNo: i + 1,
        runId: `ocr-${Date.now()}`,
      });
      pages.push(pageText);
    }

    const articleTexts = buildArticleMapFromPages(pages);
    return { pages, articleTexts };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

export async function extractArabicSourceWithStage0(params: {
  config: OpenClawConfig;
  sourcePdfPath: string;
  pdfBuffer: Uint8Array;
}): Promise<SourceExtractionResult> {
  const diagnostics: string[] = [];
  const native = await extractArabicPdfText(params.pdfBuffer);

  if (hasUsableNativeExtraction(native.pages, native.articleTexts)) {
    diagnostics.push("Native PDF text extraction used.");
    return {
      pages: native.pages,
      articleTexts: native.articleTexts,
      mode: "native",
      diagnostics,
    };
  }

  diagnostics.push("Native extraction appears incomplete; attempting LLM OCR fallback.");
  const fallback = await runLlmOcrFallback({
    config: params.config,
    sourcePdfPath: params.sourcePdfPath,
    diagnostics,
  });

  return {
    pages: fallback.pages,
    articleTexts: fallback.articleTexts,
    mode: "llm_ocr_fallback",
    diagnostics,
  };
}
