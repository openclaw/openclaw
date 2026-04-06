/**
 * Arm adapters. Each arm wraps a different extraction path and returns
 * a uniform ArmOutput so lanes can compare them fairly.
 *
 * Available arms:
 *   pdfjs-text               — current pdfjs text extraction (baseline)
 *   nutrient-cli-markdown     — Nutrient pdf-to-markdown CLI, one file per process
 *   nutrient-cli-batch-markdown — Nutrient CLI, sequential files reusing warm state estimate
 *   nutrient-py-text          — (scaffold) Nutrient Python SDK text extraction
 *   nutrient-py-markdown      — (scaffold) Nutrient Python SDK markdown extraction
 *   nutrient-py-vision        — (scaffold) Nutrient Python SDK vision pipeline
 */

import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { estimateTokens } from "./scoring.js";
import type { ArmAdapter, ArmId, ArmOutput, ArmRunOptions, CorpusEntry } from "./types.js";

const execFile = promisify(execFileCallback);

// Module-level nutrient command path, set before availability checks.
let configuredNutrientCommand = "pdf-to-markdown";

export function setNutrientCommand(command: string): void {
  configuredNutrientCommand = command;
}

// Suppress pdfjs standardFontDataUrl warning during bench runs.
function withSuppressedPdfJsWarnings<T>(fn: () => Promise<T>): Promise<T> {
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    const msg = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
    if (msg.includes("standardFontDataUrl")) {
      return;
    }
    orig(...args);
  };
  return fn().finally(() => {
    console.warn = orig;
  });
}

// ---------------------------------------------------------------------------
// pdfjs-text arm
// ---------------------------------------------------------------------------

const pdfjsTextArm: ArmAdapter = {
  id: "pdfjs-text",
  label: "pdf.js text extraction (baseline)",

  async available() {
    try {
      await import("pdfjs-dist/legacy/build/pdf.mjs");
      return true;
    } catch {
      return false;
    }
  },

  async extract(entry: CorpusEntry, options: ArmRunOptions): Promise<ArmOutput> {
    const { extractPdfContentPdfJs } = await import("../../src/media/pdf-extract.js");
    const buffer = entry.buffer ?? (await import("node:fs")).readFileSync(entry.filePath);
    const started = process.hrtime.bigint();
    try {
      const result = await withSuppressedPdfJsWarnings(() =>
        extractPdfContentPdfJs({
          buffer,
          maxPages: options.maxPages,
          maxPixels: options.maxPixels,
          minTextChars: options.minTextChars,
          engineConfigured: "pdfjs",
        }),
      );
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const text = result.text;
      return {
        armId: "pdfjs-text",
        docId: entry.id,
        text,
        timing: { durationMs },
        counts: {
          chars: text.trim().length,
          empty: text.trim().length === 0,
          imageCount: result.images.length,
          pageCountProcessed: result.meta?.pageCountProcessed,
          pageCountTotal: result.meta?.pageCountTotal,
        },
        tokenEstimate: estimateTokens(text),
      };
    } catch (error) {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      return {
        armId: "pdfjs-text",
        docId: entry.id,
        text: "",
        timing: { durationMs },
        counts: { chars: 0, empty: true, imageCount: 0 },
        tokenEstimate: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// nutrient-cli-markdown arm
// ---------------------------------------------------------------------------

async function isCliAvailable(command: string): Promise<boolean> {
  try {
    await execFile(command, ["--help"], { timeout: 5000 });
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    // CLI exists but --help might not be supported; still available
    return true;
  }
}

async function runNutrientCli(
  buffer: Buffer,
  command: string,
  timeoutMs: number,
): Promise<{ text: string; stderrSnippet?: string }> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-bench-nut-"));
  const inputPath = path.join(tmpDir, "input.pdf");
  try {
    await writeFile(inputPath, buffer);
    const { stdout, stderr } = await execFile(command, [inputPath], {
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      encoding: "utf8",
    });
    const stderrTrimmed = typeof stderr === "string" ? stderr.trim() : undefined;
    return {
      text: stdout.trim(),
      stderrSnippet: stderrTrimmed ? stderrTrimmed.slice(0, 300) : undefined,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

const nutrientCliMarkdownArm: ArmAdapter = {
  id: "nutrient-cli-markdown",
  label: "Nutrient pdf-to-markdown CLI (single file)",

  async available() {
    return isCliAvailable(configuredNutrientCommand);
  },

  async extract(entry: CorpusEntry, options: ArmRunOptions): Promise<ArmOutput> {
    const buffer = entry.buffer ?? (await import("node:fs")).readFileSync(entry.filePath);
    const started = process.hrtime.bigint();
    try {
      const { text, stderrSnippet } = await runNutrientCli(
        buffer,
        options.nutrientCommand,
        options.nutrientTimeoutMs,
      );
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      return {
        armId: "nutrient-cli-markdown",
        docId: entry.id,
        text,
        markdown: text,
        timing: { durationMs },
        counts: {
          chars: text.trim().length,
          empty: text.trim().length === 0,
          imageCount: 0,
        },
        tokenEstimate: estimateTokens(text),
        stderrSnippet,
      };
    } catch (error) {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const isEnoent =
        error && typeof error === "object" && "code" in error && error.code === "ENOENT";
      return {
        armId: "nutrient-cli-markdown",
        docId: entry.id,
        text: "",
        timing: { durationMs },
        counts: { chars: 0, empty: true, imageCount: 0 },
        tokenEstimate: 0,
        error: isEnoent
          ? `cli_missing: ${options.nutrientCommand} not found`
          : error instanceof Error
            ? error.message
            : String(error),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// nutrient-cli-batch-markdown arm
// ---------------------------------------------------------------------------

const nutrientCliBatchArm: ArmAdapter = {
  id: "nutrient-cli-batch-markdown",
  label: "Nutrient pdf-to-markdown CLI (sequential batch)",

  async available() {
    return isCliAvailable(configuredNutrientCommand);
  },

  async extract(entry: CorpusEntry, options: ArmRunOptions): Promise<ArmOutput> {
    // Single-doc path delegates to the single-file arm
    return nutrientCliMarkdownArm.extract(entry, options);
  },

  async extractBatch(entries: CorpusEntry[], options: ArmRunOptions): Promise<ArmOutput[]> {
    // Sequential batch: process files one at a time to measure per-doc overhead
    // after the first (cold) invocation. The CLI process is spawned fresh each time
    // (no persistent worker), so this measures subprocess spawn overhead vs total
    // corpus throughput.
    const results: ArmOutput[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const output = await nutrientCliMarkdownArm.extract(entry, options);
      results.push({
        ...output,
        armId: "nutrient-cli-batch-markdown",
        timing: { ...output.timing, cold: i === 0 },
      });
    }
    return results;
  },
};

// ---------------------------------------------------------------------------
// Scaffold arms (Python SDK — not yet available)
// ---------------------------------------------------------------------------

function createScaffoldArm(id: ArmId, label: string, reason: string): ArmAdapter {
  return {
    id,
    label,
    async available() {
      return false;
    },
    async extract(entry: CorpusEntry): Promise<ArmOutput> {
      return {
        armId: id,
        docId: entry.id,
        text: "",
        timing: { durationMs: 0 },
        counts: { chars: 0, empty: true, imageCount: 0 },
        tokenEstimate: 0,
        error: `not_available: ${reason}`,
      };
    },
  };
}

const nutrientPyTextArm = createScaffoldArm(
  "nutrient-py-text",
  "Nutrient Python SDK text extraction",
  "Nutrient Python SDK for local extraction is not installed. Install the nutrient package and implement the adapter in scripts/pdf-bench/arms.ts.",
);

const nutrientPyMarkdownArm = createScaffoldArm(
  "nutrient-py-markdown",
  "Nutrient Python SDK markdown extraction",
  "Nutrient Python SDK for local extraction is not installed. Install the nutrient package and implement the adapter in scripts/pdf-bench/arms.ts.",
);

const nutrientPyVisionArm = createScaffoldArm(
  "nutrient-py-vision",
  "Nutrient Python SDK vision pipeline",
  "Nutrient Python SDK vision pipeline is not installed. Install the nutrient package and implement the adapter in scripts/pdf-bench/arms.ts.",
);

// ---------------------------------------------------------------------------
// Arm registry
// ---------------------------------------------------------------------------

export const ARM_REGISTRY: Map<ArmId, ArmAdapter> = new Map([
  ["pdfjs-text", pdfjsTextArm],
  ["nutrient-cli-markdown", nutrientCliMarkdownArm],
  ["nutrient-cli-batch-markdown", nutrientCliBatchArm],
  ["nutrient-py-text", nutrientPyTextArm],
  ["nutrient-py-markdown", nutrientPyMarkdownArm],
  ["nutrient-py-vision", nutrientPyVisionArm],
]);

export function getArm(id: ArmId): ArmAdapter {
  const arm = ARM_REGISTRY.get(id);
  if (!arm) {
    throw new Error(`Unknown arm: ${id}`);
  }
  return arm;
}

export async function getAvailableArms(ids?: ArmId[]): Promise<ArmAdapter[]> {
  const candidates = ids ? ids.map((id) => getArm(id)) : [...ARM_REGISTRY.values()];
  const available: ArmAdapter[] = [];
  for (const arm of candidates) {
    if (await arm.available()) {
      available.push(arm);
    }
  }
  return available;
}

export async function checkArmAvailability(
  ids: ArmId[],
): Promise<Array<{ id: ArmId; available: boolean; label: string }>> {
  return Promise.all(
    ids.map(async (id) => {
      const arm = getArm(id);
      return { id, available: await arm.available(), label: arm.label };
    }),
  );
}
