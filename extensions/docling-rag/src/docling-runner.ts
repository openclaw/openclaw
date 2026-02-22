import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const SUPPORTED_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  ".pptx",
  ".xlsx",
  ".html",
  ".md",
  ".png",
  ".jpg",
  ".jpeg",
  ".tiff",
  ".bmp",
  ".webp",
]);

export function isSupportedFormat(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

export type DoclingResult =
  | { ok: true; markdown: string }
  | { ok: false; error: string };

/**
 * Run Docling CLI to convert a document to markdown.
 * Requires: pip install docling, or Docker with docling/docling image.
 */
export async function runDocling(
  inputPath: string,
  options?: { doclingPath?: string; timeoutMs?: number },
): Promise<DoclingResult> {
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const doclingCmd = options?.doclingPath?.trim() || "docling";

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "docling-rag-"));
  const outputPath = path.join(tempDir, "output.md");

  try {
    const result = await new Promise<DoclingResult>((resolve) => {
      const proc = spawn(
        doclingCmd,
        [inputPath, "--output", outputPath, "--format", "markdown"],
        {
          stdio: ["ignore", "pipe", "pipe"],
          shell: process.platform === "win32",
        },
      );

      let stderr = "";
      proc.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      const timeout = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve({
          ok: false,
          error: `Docling timed out after ${timeoutMs / 1000}s. Install docling: pip install docling`,
        });
      }, timeoutMs);

      proc.on("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          resolve({
            ok: false,
            error: stderr || `Docling exited with code ${code}. Install: pip install docling`,
          });
          return;
        }
        resolve({ ok: true, markdown: "" });
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        resolve({
          ok: false,
          error: `Failed to run docling: ${err.message}. Install: pip install docling`,
        });
      });
    });

    if (!result.ok) {
      return result;
    }

    const markdown = await fs.readFile(outputPath, "utf-8");
    return { ok: true, markdown };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
