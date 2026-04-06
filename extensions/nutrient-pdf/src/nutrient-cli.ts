/**
 * Nutrient pdf-to-markdown CLI wrapper.
 * Handles binary discovery, availability checking, and PDF extraction.
 */

import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 20 * 1024 * 1024;
const MAX_PDF_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

export type NutrientCliConfig = {
  command?: string;
  timeoutMs?: number;
};

export type NutrientExtractionResult = {
  markdown: string;
  durationMs: number;
  stderrSnippet?: string;
};

/**
 * Resolve the pdf-to-markdown binary path.
 * Checks the plugin's own node_modules/.bin first, then falls back to PATH.
 */
function resolveDefaultCommand(): string {
  try {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    // From src/nutrient-cli.ts, go up to plugin root, then into node_modules/.bin
    const localBin = path.resolve(thisDir, "..", "node_modules", ".bin", "pdf-to-markdown");
    return localBin;
  } catch {
    return "pdf-to-markdown";
  }
}

function resolveCommand(configured?: string): string {
  return configured ?? resolveDefaultCommand();
}

/**
 * Check whether the Nutrient CLI binary is available.
 */
export async function isNutrientCliAvailable(command?: string): Promise<boolean> {
  const cmd = resolveCommand(command);
  try {
    await execFile(cmd, ["--version"], { timeout: 10_000 });
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      // Also try bare PATH fallback if local resolution failed
      if (cmd !== "pdf-to-markdown") {
        try {
          await execFile("pdf-to-markdown", ["--version"], { timeout: 10_000 });
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
    // CLI exists but --version might behave differently; still available
    return true;
  }
}

/**
 * Get the version string from the Nutrient CLI.
 */
export async function getNutrientCliVersion(command?: string): Promise<string | null> {
  const cmd = resolveCommand(command);
  try {
    const { stdout } = await execFile(cmd, ["--version"], { timeout: 10_000, encoding: "utf8" });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Validate a PDF file path before reading.
 * Enforces .pdf extension and size cap.
 */
export async function validatePdfPath(
  pdfPath: string,
): Promise<{ resolvedPath: string; buffer: Buffer }> {
  const resolved = path.resolve(pdfPath);

  // Enforce .pdf extension
  if (!resolved.toLowerCase().endsWith(".pdf")) {
    throw new Error(`File must have .pdf extension: ${resolved}`);
  }

  const buffer = await readFile(resolved);

  // Enforce size cap
  if (buffer.length > MAX_PDF_SIZE_BYTES) {
    throw new Error(
      `PDF exceeds maximum size: ${(buffer.length / 1024 / 1024).toFixed(1)}MB > ${MAX_PDF_SIZE_BYTES / 1024 / 1024}MB`,
    );
  }

  return { resolvedPath: resolved, buffer };
}

/**
 * Extract markdown from a PDF buffer using the Nutrient CLI.
 */
export async function extractWithNutrientCli(
  buffer: Buffer,
  config?: NutrientCliConfig,
): Promise<NutrientExtractionResult> {
  const command = resolveCommand(config?.command);
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const startedAt = Date.now();
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-nutrient-pdf-"));
  const inputPath = path.join(tmpDir, "input.pdf");

  try {
    await writeFile(inputPath, buffer);
    const { stdout, stderr } = await execFile(command, [inputPath], {
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
      encoding: "utf8",
    });
    const durationMs = Date.now() - startedAt;
    const stderrTrimmed = typeof stderr === "string" ? stderr.trim() : undefined;
    return {
      markdown: stdout.trim(),
      durationMs,
      stderrSnippet: stderrTrimmed ? stderrTrimmed.slice(0, 300) : undefined,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
