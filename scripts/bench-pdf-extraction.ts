import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractPdfContentNutrient,
  extractPdfContentPdfJs,
  type PdfExtractedContent,
} from "../src/media/pdf-extract.js";

type EngineId = "pdfjs" | "nutrient";

type PdfCorpusEntry = {
  id: string;
  label: string;
  filePath: string;
  expectedSnippets?: string[];
};

type Sample = {
  durationMs: number;
  metaDurationMs: number | null;
  chars: number;
  empty: boolean;
  imageCount: number;
  containsExpectedText: boolean | null;
};

type SummaryStats = {
  avg: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
};

type EngineResult = {
  engine: EngineId;
  samples: Sample[];
  summary: {
    sampleCount: number;
    durationMs: SummaryStats;
    metaDurationMs: SummaryStats | null;
    chars: SummaryStats;
    imageCount: SummaryStats;
    emptyCount: number;
    containsExpectedTextHits: number | null;
    containsExpectedTextTotal: number | null;
  };
  stderrSnippet?: string;
};

type FileResult = {
  id: string;
  label: string;
  filePath: string;
  bytes: number;
  expectedSnippets?: string[];
  results: EngineResult[];
};

type BenchReport = {
  node: string;
  generatedAt: string;
  runs: number;
  warmup: number;
  maxPages: number;
  maxPixels: number;
  minTextChars: number;
  nutrientCommand: string;
  nutrientTimeoutMs: number;
  fileCount: number;
  files: FileResult[];
  aggregate: {
    pdfjs: AggregateEngineSummary;
    nutrient: AggregateEngineSummary;
    nutrientVsPdfjs: {
      avgDurationDeltaMs: number;
      avgDurationDeltaPct: number | null;
      avgCharsDelta: number;
    };
  };
};

type AggregateEngineSummary = {
  sampleCount: number;
  fileCount: number;
  avgDurationMs: number;
  p50DurationMs: number;
  avgChars: number;
  avgImageCount: number;
  emptyCount: number;
  containsExpectedTextHits: number | null;
  containsExpectedTextTotal: number | null;
};

type CliOptions = {
  pdfs: string[];
  inputDir?: string;
  smoke: boolean;
  runs: number;
  warmup: number;
  maxPages: number;
  maxPixels: number;
  minTextChars: number;
  nutrientCommand: string;
  nutrientTimeoutMs: number;
  json: boolean;
  output?: string;
};

const DEFAULT_RUNS = 3;
const DEFAULT_WARMUP = 1;
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_MAX_PIXELS = 4_000_000;
const DEFAULT_MIN_TEXT_CHARS = 200;
const DEFAULT_NUTRIENT_COMMAND = "pdf-to-markdown";
const DEFAULT_NUTRIENT_TIMEOUT_MS = 30_000;

function parseFlagValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

function parseRepeatableFlag(flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === flag && process.argv[index + 1]) {
      values.push(process.argv[index + 1]);
    }
  }
  return values;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseOptions(): CliOptions {
  return {
    pdfs: parseRepeatableFlag("--pdf"),
    inputDir: parseFlagValue("--input-dir"),
    smoke: hasFlag("--smoke"),
    runs: parsePositiveInt(parseFlagValue("--runs"), DEFAULT_RUNS),
    warmup: parsePositiveInt(parseFlagValue("--warmup"), DEFAULT_WARMUP),
    maxPages: parsePositiveInt(parseFlagValue("--max-pages"), DEFAULT_MAX_PAGES),
    maxPixels: parsePositiveInt(parseFlagValue("--max-pixels"), DEFAULT_MAX_PIXELS),
    minTextChars: parsePositiveInt(parseFlagValue("--min-text-chars"), DEFAULT_MIN_TEXT_CHARS),
    nutrientCommand: parseFlagValue("--nutrient-command") ?? DEFAULT_NUTRIENT_COMMAND,
    nutrientTimeoutMs: parsePositiveInt(
      parseFlagValue("--nutrient-timeout-ms"),
      DEFAULT_NUTRIENT_TIMEOUT_MS,
    ),
    json: hasFlag("--json"),
    output: parseFlagValue("--output"),
  };
}

function printUsage(): void {
  console.log(`OpenClaw PDF extraction benchmark

Usage:
  pnpm tsx scripts/bench-pdf-extraction.ts [options]

Options:
  --pdf <path>                  PDF to benchmark; repeatable
  --input-dir <dir>             Read *.pdf files from a directory (non-recursive)
  --smoke                       Generate a synthetic smoke corpus and benchmark it
  --runs <n>                    Measured runs per engine/file (default: ${DEFAULT_RUNS})
  --warmup <n>                  Warmup runs per engine/file (default: ${DEFAULT_WARMUP})
  --max-pages <n>               Max pages passed into extractors (default: ${DEFAULT_MAX_PAGES})
  --max-pixels <n>              pdfjs image pixel budget (default: ${DEFAULT_MAX_PIXELS})
  --min-text-chars <n>          Text threshold before pdfjs renders images (default: ${DEFAULT_MIN_TEXT_CHARS})
  --nutrient-command <cmd>      pdf-to-markdown command to invoke (default: ${DEFAULT_NUTRIENT_COMMAND})
  --nutrient-timeout-ms <ms>    Nutrient extractor timeout (default: ${DEFAULT_NUTRIENT_TIMEOUT_MS})
  --output <path>               Write JSON report to a file
  --json                        Print JSON report to stdout
  --help                        Show this help

Examples:
  pnpm test:pdf:bench:smoke
  pnpm test:pdf:bench -- --pdf /tmp/report.pdf
  pnpm test:pdf:bench -- --input-dir ./fixtures/pdfs --runs 5 --output .artifacts/pdf-extraction-bench.json
  pnpm test:pdf:bench -- --smoke --nutrient-command /Users/nuthome/.local/bin/pdf-to-markdown
`);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle] ?? 0;
}

function summarizeNumbers(values: number[]): SummaryStats {
  if (values.length === 0) {
    return { avg: 0, p50: 0, p95: 0, min: 0, max: 0 };
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    avg: total / values.length,
    p50: median(values),
    p95: percentile(values, 95),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function formatMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}

function formatPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) {
    return "n/a";
  }
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function normalizeForContains(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`#>*_|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function withFilteredPdfJsWarnings<T>(run: () => Promise<T>): Promise<T> {
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const rendered = args
      .map((value) => (typeof value === "string" ? value : String(value)))
      .join(" ");
    if (rendered.includes("standardFontDataUrl")) {
      return;
    }
    originalWarn(...args);
  };
  try {
    return await run();
  } finally {
    console.warn = originalWarn;
  }
}

function sanitizePdfText(text: string): string {
  return text.replace(/[()\\]/g, " ");
}

function createPdfBuffer(lines: string[]): Buffer {
  const content = [
    "BT /F1 12 Tf 72 720 Td",
    ...lines.map((line, index) => {
      const escaped = sanitizePdfText(line);
      return index === 0 ? `(${escaped}) Tj` : `0 -18 Td (${escaped}) Tj`;
    }),
    "ET",
  ].join("\n");

  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n",
    `4 0 obj << /Length ${Buffer.byteLength(content, "utf8")} >> stream\n${content}\nendstream endobj\n`,
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += object;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

function createSmokeCorpus(tmpDir: string): PdfCorpusEntry[] {
  const entries = [
    {
      id: "smoke-1",
      label: "smoke-1 heading paragraph",
      fileName: "smoke-1.pdf",
      lines: [
        "Phase 3 smoke benchmark",
        "OpenClaw should compare pdfjs with pdf to markdown output on longer text samples that do not trigger image rendering.",
        "The goal is to measure extraction latency and whether the main sentences survive both paths with roughly the same reading order and spacing.",
        "This extra sentence keeps the paragraph above the default text threshold so the smoke case behaves like the normal text first production path.",
      ],
      expectedSnippets: [
        "Phase 3 smoke benchmark",
        "compare pdfjs with pdf to markdown output",
        "default text threshold",
      ],
    },
    {
      id: "smoke-2",
      label: "smoke-2 bullets",
      fileName: "smoke-2.pdf",
      lines: [
        "Checklist",
        "Bullet alpha verifies headings and labels remain readable after extraction.",
        "Bullet beta checks repeated sentence structure and whitespace normalization across engines.",
        "Bullet gamma keeps the sample above the default text threshold so pdfjs stays in text mode.",
      ],
      expectedSnippets: ["Checklist", "Bullet alpha", "Bullet gamma"],
    },
    {
      id: "smoke-3",
      label: "smoke-3 tableish text",
      fileName: "smoke-3.pdf",
      lines: [
        "Quarter Revenue Margin Summary",
        "Q1 revenue 120 margin 31 with enterprise renewals leading the quarter.",
        "Q2 revenue 145 margin 34 with expansion offsetting slower new logo close rates.",
        "Q3 revenue 171 margin 36 with pricing discipline and support efficiency improving operating leverage.",
      ],
      expectedSnippets: ["Quarter Revenue Margin Summary", "Q1 revenue 120 margin 31", "Q3 revenue 171 margin 36"],
    },
  ] as const;

  return entries.map((entry) => {
    const filePath = path.join(tmpDir, entry.fileName);
    writeFileSync(filePath, createPdfBuffer([...entry.lines]), "utf8");
    return {
      id: entry.id,
      label: entry.label,
      filePath,
      expectedSnippets: [...entry.expectedSnippets],
    };
  });
}

function listPdfFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".pdf"))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => path.join(dir, name));
}

function resolveCorpus(options: CliOptions, smokeDir?: string): PdfCorpusEntry[] {
  const files = new Set<string>();
  for (const pdf of options.pdfs) {
    files.add(path.resolve(pdf));
  }
  if (options.inputDir) {
    for (const pdf of listPdfFiles(path.resolve(options.inputDir))) {
      files.add(pdf);
    }
  }

  const entries: PdfCorpusEntry[] = [...files].map((filePath, index) => ({
    id: `pdf-${index + 1}`,
    label: path.basename(filePath),
    filePath,
  }));

  if (options.smoke) {
    if (!smokeDir) {
      throw new Error("smokeDir is required when --smoke is enabled");
    }
    entries.push(...createSmokeCorpus(smokeDir));
  }

  if (entries.length === 0) {
    throw new Error("Provide at least one --pdf, --input-dir, or --smoke corpus.");
  }

  return entries;
}

async function runEngine(params: {
  engine: EngineId;
  entry: PdfCorpusEntry;
  buffer: Buffer;
  options: CliOptions;
}): Promise<EngineResult> {
  const samples: Sample[] = [];
  let last: PdfExtractedContent | null = null;
  const totalRuns = params.options.warmup + params.options.runs;

  for (let runIndex = 0; runIndex < totalRuns; runIndex += 1) {
    const started = process.hrtime.bigint();
    const result = await withFilteredPdfJsWarnings(() =>
      params.engine === "pdfjs"
        ? extractPdfContentPdfJs({
            buffer: params.buffer,
            maxPages: params.options.maxPages,
            maxPixels: params.options.maxPixels,
            minTextChars: params.options.minTextChars,
            engineConfigured: "pdfjs",
          })
        : extractPdfContentNutrient({
            buffer: params.buffer,
            maxPages: params.options.maxPages,
            maxPixels: params.options.maxPixels,
            minTextChars: params.options.minTextChars,
            nutrientCommand: params.options.nutrientCommand,
            nutrientTimeoutMs: params.options.nutrientTimeoutMs,
            engineConfigured: "nutrient",
          }),
    );
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    last = result;
    if (runIndex < params.options.warmup) {
      continue;
    }
    const containsExpectedText =
      Array.isArray(params.entry.expectedSnippets) && params.entry.expectedSnippets.length > 0
        ? params.entry.expectedSnippets.every((snippet) =>
            normalizeForContains(result.text).includes(normalizeForContains(snippet)),
          )
        : null;
    samples.push({
      durationMs,
      metaDurationMs: typeof result.meta?.durationMs === "number" ? result.meta.durationMs : null,
      chars: typeof result.meta?.chars === "number" ? result.meta.chars : result.text.trim().length,
      empty: result.meta?.empty ?? result.text.trim().length === 0,
      imageCount: typeof result.meta?.imageCount === "number" ? result.meta.imageCount : result.images.length,
      containsExpectedText,
    });
  }

  const expectedSamples = samples.filter(
    (sample): sample is Sample & { containsExpectedText: boolean } =>
      typeof sample.containsExpectedText === "boolean",
  );

  return {
    engine: params.engine,
    samples,
    summary: {
      sampleCount: samples.length,
      durationMs: summarizeNumbers(samples.map((sample) => sample.durationMs)),
      metaDurationMs:
        samples.some((sample) => typeof sample.metaDurationMs === "number")
          ? summarizeNumbers(
              samples
                .map((sample) => sample.metaDurationMs)
                .filter((value): value is number => typeof value === "number"),
            )
          : null,
      chars: summarizeNumbers(samples.map((sample) => sample.chars)),
      imageCount: summarizeNumbers(samples.map((sample) => sample.imageCount)),
      emptyCount: samples.filter((sample) => sample.empty).length,
      containsExpectedTextHits:
        expectedSamples.length > 0
          ? expectedSamples.filter((sample) => sample.containsExpectedText).length
          : null,
      containsExpectedTextTotal: expectedSamples.length > 0 ? expectedSamples.length : null,
    },
    ...(last?.meta?.stderrSnippet ? { stderrSnippet: last.meta.stderrSnippet } : {}),
  };
}

function summarizeAggregate(engine: EngineId, files: FileResult[]): AggregateEngineSummary {
  const engineResults = files
    .flatMap((file) => file.results)
    .filter((result): result is EngineResult => result.engine === engine);
  const samples = engineResults.flatMap((result) => result.samples);
  const expectedTotals = engineResults
    .map((result) => result.summary.containsExpectedTextTotal)
    .filter((value): value is number => typeof value === "number");
  const expectedHits = engineResults
    .map((result) => result.summary.containsExpectedTextHits)
    .filter((value): value is number => typeof value === "number");

  return {
    sampleCount: samples.length,
    fileCount: engineResults.length,
    avgDurationMs: summarizeNumbers(samples.map((sample) => sample.durationMs)).avg,
    p50DurationMs: summarizeNumbers(samples.map((sample) => sample.durationMs)).p50,
    avgChars: summarizeNumbers(samples.map((sample) => sample.chars)).avg,
    avgImageCount: summarizeNumbers(samples.map((sample) => sample.imageCount)).avg,
    emptyCount: samples.filter((sample) => sample.empty).length,
    containsExpectedTextHits: expectedHits.length > 0 ? expectedHits.reduce((sum, value) => sum + value, 0) : null,
    containsExpectedTextTotal:
      expectedTotals.length > 0 ? expectedTotals.reduce((sum, value) => sum + value, 0) : null,
  };
}

function printHumanReport(report: BenchReport): void {
  console.log(`Node: ${report.node}`);
  console.log(`Generated: ${report.generatedAt}`);
  console.log(`Files: ${report.fileCount}`);
  console.log(`Runs per engine/file: ${report.runs}`);
  console.log(`Warmup runs per engine/file: ${report.warmup}`);
  console.log(`Nutrient command: ${report.nutrientCommand}`);
  console.log("");

  for (const file of report.files) {
    console.log(`${file.label} (${file.bytes} bytes)`);
    for (const result of file.results) {
      const expected =
        result.summary.containsExpectedTextTotal == null
          ? "expected=n/a"
          : `expected=${result.summary.containsExpectedTextHits}/${result.summary.containsExpectedTextTotal}`;
      const stderr = result.stderrSnippet ? ` stderr=${JSON.stringify(result.stderrSnippet)}` : "";
      console.log(
        `  ${result.engine.padEnd(8)} avg=${formatMs(result.summary.durationMs.avg)} p50=${formatMs(result.summary.durationMs.p50)} chars=${result.summary.chars.avg.toFixed(1)} images=${result.summary.imageCount.avg.toFixed(1)} empty=${result.summary.emptyCount}/${result.summary.sampleCount} ${expected}${stderr}`,
      );
    }
    const pdfjs = file.results.find((result) => result.engine === "pdfjs");
    const nutrient = file.results.find((result) => result.engine === "nutrient");
    if (pdfjs && nutrient) {
      const deltaMs = nutrient.summary.durationMs.avg - pdfjs.summary.durationMs.avg;
      const deltaPct =
        pdfjs.summary.durationMs.avg > 0
          ? (deltaMs / pdfjs.summary.durationMs.avg) * 100
          : null;
      console.log(
        `  delta    avg=${deltaMs >= 0 ? "+" : ""}${formatMs(deltaMs)} (${formatPct(deltaPct)}) chars=${(nutrient.summary.chars.avg - pdfjs.summary.chars.avg).toFixed(1)}`,
      );
    }
    console.log("");
  }

  console.log("Aggregate");
  console.log(
    `  pdfjs    avg=${formatMs(report.aggregate.pdfjs.avgDurationMs)} p50=${formatMs(report.aggregate.pdfjs.p50DurationMs)} chars=${report.aggregate.pdfjs.avgChars.toFixed(1)} images=${report.aggregate.pdfjs.avgImageCount.toFixed(1)} empty=${report.aggregate.pdfjs.emptyCount}/${report.aggregate.pdfjs.sampleCount}`,
  );
  console.log(
    `  nutrient avg=${formatMs(report.aggregate.nutrient.avgDurationMs)} p50=${formatMs(report.aggregate.nutrient.p50DurationMs)} chars=${report.aggregate.nutrient.avgChars.toFixed(1)} images=${report.aggregate.nutrient.avgImageCount.toFixed(1)} empty=${report.aggregate.nutrient.emptyCount}/${report.aggregate.nutrient.sampleCount}`,
  );
  console.log(
    `  delta    avg=${report.aggregate.nutrientVsPdfjs.avgDurationDeltaMs >= 0 ? "+" : ""}${formatMs(report.aggregate.nutrientVsPdfjs.avgDurationDeltaMs)} (${formatPct(report.aggregate.nutrientVsPdfjs.avgDurationDeltaPct)}) chars=${report.aggregate.nutrientVsPdfjs.avgCharsDelta.toFixed(1)}`,
  );
}

async function main(): Promise<void> {
  if (hasFlag("--help")) {
    printUsage();
    return;
  }

  const options = parseOptions();
  const smokeDir = options.smoke ? mkdtempSync(path.join(os.tmpdir(), "openclaw-pdf-bench-")) : undefined;

  try {
    const corpus = resolveCorpus(options, smokeDir);
    const files: FileResult[] = [];

    for (const entry of corpus) {
      const buffer = readFileSync(entry.filePath);
      const pdfjs = await runEngine({ engine: "pdfjs", entry, buffer, options });
      const nutrient = await runEngine({ engine: "nutrient", entry, buffer, options });
      files.push({
        id: entry.id,
        label: entry.label,
        filePath: entry.filePath,
        bytes: buffer.length,
        ...(entry.expectedSnippets ? { expectedSnippets: entry.expectedSnippets } : {}),
        results: [pdfjs, nutrient],
      });
    }

    const aggregatePdfjs = summarizeAggregate("pdfjs", files);
    const aggregateNutrient = summarizeAggregate("nutrient", files);
    const avgDurationDeltaMs = aggregateNutrient.avgDurationMs - aggregatePdfjs.avgDurationMs;
    const avgDurationDeltaPct =
      aggregatePdfjs.avgDurationMs > 0
        ? (avgDurationDeltaMs / aggregatePdfjs.avgDurationMs) * 100
        : null;

    const report: BenchReport = {
      node: process.version,
      generatedAt: new Date().toISOString(),
      runs: options.runs,
      warmup: options.warmup,
      maxPages: options.maxPages,
      maxPixels: options.maxPixels,
      minTextChars: options.minTextChars,
      nutrientCommand: options.nutrientCommand,
      nutrientTimeoutMs: options.nutrientTimeoutMs,
      fileCount: files.length,
      files,
      aggregate: {
        pdfjs: aggregatePdfjs,
        nutrient: aggregateNutrient,
        nutrientVsPdfjs: {
          avgDurationDeltaMs,
          avgDurationDeltaPct,
          avgCharsDelta: aggregateNutrient.avgChars - aggregatePdfjs.avgChars,
        },
      },
    };

    if (options.output) {
      mkdirSync(path.dirname(options.output), { recursive: true });
      writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    printHumanReport(report);
  } finally {
    if (smokeDir) {
      rmSync(smokeDir, { recursive: true, force: true });
    }
  }
}

await main();
