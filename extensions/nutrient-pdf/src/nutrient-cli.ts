/**
 * Nutrient pdf-to-markdown CLI wrapper.
 * Handles binary discovery, availability checking, and PDF extraction.
 */

import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const DEFAULT_COMMAND = "pdf-to-markdown";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 20 * 1024 * 1024;

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
 * Check whether the Nutrient CLI binary is available.
 */
export async function isNutrientCliAvailable(command?: string): Promise<boolean> {
  const cmd = command ?? DEFAULT_COMMAND;
  try {
    await execFile(cmd, ["--version"], { timeout: 10_000 });
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
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
  const cmd = command ?? DEFAULT_COMMAND;
  try {
    const { stdout } = await execFile(cmd, ["--version"], { timeout: 10_000, encoding: "utf8" });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Extract markdown from a PDF buffer using the Nutrient CLI.
 */
export async function extractWithNutrientCli(
  buffer: Buffer,
  config?: NutrientCliConfig,
): Promise<NutrientExtractionResult> {
  const command = config?.command ?? DEFAULT_COMMAND;
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
