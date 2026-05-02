import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

const execAsync = promisify(exec);

export type QaMemoryRetrievalExpectedMatch = {
  pathContains?: string;
  contentAny?: string[];
};

export type QaMemoryRetrievalCase = {
  id: string;
  priority?: string;
  agent?: string;
  query: string;
  intent?: string;
  expectedAny?: QaMemoryRetrievalExpectedMatch[];
  mustAvoid?: string[];
  allowedSessionHeavy?: boolean;
};

export type QaMemoryRetrievalCasePack = {
  version?: number;
  description?: string;
  scoring?: {
    rankThresholds?: Record<string, number>;
    excludeResultNeedles?: string[];
  };
  cases: QaMemoryRetrievalCase[];
};

export type QaMemoryRetrievalCandidate = {
  label: string;
  commandTemplate: string;
};

export type QaMemoryRetrievalResult = {
  path?: string;
  score?: number;
  source?: string;
  snippet?: string;
  text?: string;
  content?: string;
};

export type QaMemoryRetrievalCaseResult = {
  caseId: string;
  priority: string;
  agent: string;
  query: string;
  status: "pass" | "weak-pass" | "fail" | "timeout" | "error";
  expectedRank?: number;
  threshold: number;
  durationMs: number;
  resultCount: number;
  excludedResultCount: number;
  error?: string;
  top: QaMemoryRetrievalResult[];
};

export type QaMemoryRetrievalCandidateReport = {
  label: string;
  commandTemplate: string;
  counts: Record<QaMemoryRetrievalCaseResult["status"], number>;
  cases: QaMemoryRetrievalCaseResult[];
};

export type QaMemoryRetrievalReport = {
  generatedAt: string;
  description?: string;
  caseFile: string;
  candidates: QaMemoryRetrievalCandidateReport[];
};

export type RunQaMemoryRetrievalEvalOptions = {
  caseFile: string;
  outputDir?: string;
  candidate: string[];
  timeoutMs?: number;
  maxTopResults?: number;
};

type RawCandidateOutput = {
  results?: unknown;
};

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeCase(raw: unknown, index: number): QaMemoryRetrievalCase {
  assertRecord(raw, `cases[${index}]`);
  const id = readString(raw.id)?.trim();
  const query = readString(raw.query)?.trim();
  if (!id) {
    throw new Error(`cases[${index}].id is required`);
  }
  if (!query) {
    throw new Error(`cases[${index}].query is required`);
  }
  const expectedAny = Array.isArray(raw.expectedAny)
    ? raw.expectedAny.map((entry, expectedIndex) => {
        assertRecord(entry, `cases[${index}].expectedAny[${expectedIndex}]`);
        return {
          pathContains: readString(entry.pathContains),
          contentAny: Array.isArray(entry.contentAny)
            ? entry.contentAny.filter((item): item is string => typeof item === "string")
            : undefined,
        };
      })
    : undefined;
  return {
    id,
    query,
    priority: readString(raw.priority),
    agent: readString(raw.agent),
    intent: readString(raw.intent),
    expectedAny,
    mustAvoid: Array.isArray(raw.mustAvoid)
      ? raw.mustAvoid.filter((item): item is string => typeof item === "string")
      : undefined,
    allowedSessionHeavy: raw.allowedSessionHeavy === true,
  };
}

export async function readQaMemoryRetrievalCasePack(
  caseFile: string,
): Promise<QaMemoryRetrievalCasePack> {
  const text = await fs.readFile(caseFile, "utf8");
  const raw = JSON.parse(text) as unknown;
  assertRecord(raw, "case file");
  if (!Array.isArray(raw.cases)) {
    throw new Error("case file must include cases[]");
  }
  const scoring = raw.scoring && typeof raw.scoring === "object" ? raw.scoring : undefined;
  const scoringRecord = scoring as Record<string, unknown> | undefined;
  const rawRankThresholds =
    scoringRecord?.rankThresholds && typeof scoringRecord.rankThresholds === "object"
      ? (scoringRecord.rankThresholds as Record<string, unknown>)
      : undefined;
  const rankThresholds: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawRankThresholds ?? {})) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      rankThresholds[key] = Math.floor(value);
    }
  }
  return {
    version: readNumber(raw.version),
    description: readString(raw.description),
    scoring: {
      rankThresholds,
      excludeResultNeedles: Array.isArray(scoringRecord?.excludeResultNeedles)
        ? scoringRecord.excludeResultNeedles.filter(
            (item): item is string => typeof item === "string",
          )
        : undefined,
    },
    cases: raw.cases.map(normalizeCase),
  };
}

export function parseQaMemoryRetrievalCandidate(input: string): QaMemoryRetrievalCandidate {
  const separator = input.indexOf("=");
  if (separator <= 0 || separator === input.length - 1) {
    throw new Error('--candidate must use label=command-template, for example qmd="openclaw ..."');
  }
  const label = input.slice(0, separator).trim();
  const commandTemplate = input.slice(separator + 1).trim();
  if (!label || !commandTemplate) {
    throw new Error("--candidate requires both a label and a command template");
  }
  return { label, commandTemplate };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function renderQaMemoryRetrievalCommand(
  template: string,
  testCase: QaMemoryRetrievalCase,
): string {
  const replacements: Record<string, string> = {
    agent: testCase.agent ?? "main",
    caseId: testCase.id,
    query: testCase.query,
  };
  return template.replace(/\{(agent|caseId|query)\}/g, (_match, key: string) =>
    shellQuote(replacements[key] ?? ""),
  );
}

function normalizeSearchResult(raw: unknown): QaMemoryRetrievalResult | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  return {
    path: readString(record.path ?? record.file ?? record.docid),
    score: readNumber(record.score),
    source: readString(record.source ?? record.collection),
    snippet: readString(record.snippet),
    text: readString(record.text),
    content: readString(record.content ?? record.body),
  };
}

export function parseQaMemoryRetrievalResults(stdout: string): QaMemoryRetrievalResult[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }
  const parsed = JSON.parse(trimmed) as RawCandidateOutput | unknown[];
  const rawResults: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray(parsed.results)
      ? (parsed.results as unknown[])
      : [];
  return rawResults
    .map(normalizeSearchResult)
    .filter((result): result is QaMemoryRetrievalResult => result !== null);
}

function resultText(result: QaMemoryRetrievalResult): string {
  return [result.path, result.source, result.snippet, result.text, result.content]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");
}

function matchesExpected(
  result: QaMemoryRetrievalResult,
  expected: QaMemoryRetrievalExpectedMatch,
): boolean {
  const pathNeedle = normalizeLowercaseStringOrEmpty(expected.pathContains ?? "");
  const resultPath = normalizeLowercaseStringOrEmpty(result.path ?? "");
  if (pathNeedle && !resultPath.includes(pathNeedle)) {
    return false;
  }
  const contentNeedles = expected.contentAny ?? [];
  if (contentNeedles.length === 0) {
    return Boolean(pathNeedle);
  }
  const haystack = normalizeLowercaseStringOrEmpty(resultText(result));
  return contentNeedles.some((needle) =>
    haystack.includes(normalizeLowercaseStringOrEmpty(needle)),
  );
}

function isExcludedResult(result: QaMemoryRetrievalResult, needles: readonly string[]): boolean {
  if (needles.length === 0) {
    return false;
  }
  const haystack = normalizeLowercaseStringOrEmpty(resultText(result));
  return needles.some((needle) => haystack.includes(normalizeLowercaseStringOrEmpty(needle)));
}

function resolveRankThreshold(
  pack: QaMemoryRetrievalCasePack,
  testCase: QaMemoryRetrievalCase,
): number {
  const priority = normalizeLowercaseStringOrEmpty(testCase.priority ?? "p2");
  return (
    pack.scoring?.rankThresholds?.[priority] ?? (priority === "p0" || priority === "p1" ? 3 : 5)
  );
}

export function evaluateQaMemoryRetrievalCase(params: {
  pack: QaMemoryRetrievalCasePack;
  testCase: QaMemoryRetrievalCase;
  results: QaMemoryRetrievalResult[];
  durationMs: number;
  maxTopResults: number;
}): QaMemoryRetrievalCaseResult {
  const excludeNeedles = [
    ...(params.pack.scoring?.excludeResultNeedles ?? []),
    ...(params.testCase.mustAvoid ?? []),
  ];
  const filteredResults = params.results.filter(
    (result) => !isExcludedResult(result, excludeNeedles),
  );
  const excludedResultCount = params.results.length - filteredResults.length;
  const expected = params.testCase.expectedAny ?? [];
  const expectedIndex = expected.length
    ? filteredResults.findIndex((result) =>
        expected.some((entry) => matchesExpected(result, entry)),
      )
    : filteredResults.length > 0
      ? 0
      : -1;
  const expectedRank = expectedIndex >= 0 ? expectedIndex + 1 : undefined;
  const threshold = resolveRankThreshold(params.pack, params.testCase);
  const status =
    expectedRank === undefined ? "fail" : expectedRank <= threshold ? "pass" : "weak-pass";
  return {
    caseId: params.testCase.id,
    priority: params.testCase.priority ?? "p2",
    agent: params.testCase.agent ?? "main",
    query: params.testCase.query,
    status,
    expectedRank,
    threshold,
    durationMs: params.durationMs,
    resultCount: filteredResults.length,
    excludedResultCount,
    top: filteredResults.slice(0, params.maxTopResults),
  };
}

async function runCandidateCase(params: {
  pack: QaMemoryRetrievalCasePack;
  candidate: QaMemoryRetrievalCandidate;
  testCase: QaMemoryRetrievalCase;
  timeoutMs: number;
  maxTopResults: number;
}): Promise<QaMemoryRetrievalCaseResult> {
  const command = renderQaMemoryRetrievalCommand(params.candidate.commandTemplate, params.testCase);
  const start = Date.now();
  try {
    const { stdout } = await execAsync(command, {
      timeout: params.timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    });
    const durationMs = Date.now() - start;
    const results = parseQaMemoryRetrievalResults(stdout);
    return evaluateQaMemoryRetrievalCase({
      pack: params.pack,
      testCase: params.testCase,
      results,
      durationMs,
      maxTopResults: params.maxTopResults,
    });
  } catch (error) {
    const durationMs = Date.now() - start;
    const message = formatErrorMessage(error);
    const timedOut = /timed out|timeout/i.test(message);
    return {
      caseId: params.testCase.id,
      priority: params.testCase.priority ?? "p2",
      agent: params.testCase.agent ?? "main",
      query: params.testCase.query,
      status: timedOut ? "timeout" : "error",
      threshold: resolveRankThreshold(params.pack, params.testCase),
      durationMs,
      resultCount: 0,
      excludedResultCount: 0,
      error: message,
      top: [],
    };
  }
}

function countStatuses(cases: QaMemoryRetrievalCaseResult[]) {
  const counts: Record<QaMemoryRetrievalCaseResult["status"], number> = {
    pass: 0,
    "weak-pass": 0,
    fail: 0,
    timeout: 0,
    error: 0,
  };
  for (const result of cases) {
    counts[result.status] += 1;
  }
  return counts;
}

export function renderQaMemoryRetrievalMarkdownReport(report: QaMemoryRetrievalReport): string {
  const lines: string[] = [];
  lines.push("# Memory Retrieval Eval");
  lines.push("");
  if (report.description) {
    lines.push(report.description);
    lines.push("");
  }
  lines.push(`Case file: \`${report.caseFile}\``);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  for (const candidate of report.candidates) {
    lines.push(`## ${candidate.label}`);
    lines.push("");
    lines.push(
      `Counts: pass ${candidate.counts.pass}, weak-pass ${candidate.counts["weak-pass"]}, fail ${candidate.counts.fail}, timeout ${candidate.counts.timeout}, error ${candidate.counts.error}`,
    );
    lines.push("");
    lines.push("| Case | Status | Rank | Time | Top Path |");
    lines.push("| --- | --- | ---: | ---: | --- |");
    for (const result of candidate.cases) {
      const topPath = result.top[0]?.path ?? result.error ?? "";
      lines.push(
        `| \`${result.caseId}\` | ${result.status} | ${result.expectedRank ?? "-"} / ${result.threshold} | ${result.durationMs}ms | \`${topPath.replaceAll("|", "\\|")}\` |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export async function runQaMemoryRetrievalEval(
  opts: RunQaMemoryRetrievalEvalOptions,
): Promise<QaMemoryRetrievalReport & { reportPath: string; summaryPath: string }> {
  const caseFile = path.resolve(opts.caseFile);
  const pack = await readQaMemoryRetrievalCasePack(caseFile);
  const candidates = opts.candidate.map(parseQaMemoryRetrievalCandidate);
  if (candidates.length === 0) {
    throw new Error("At least one --candidate label=command-template is required");
  }
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxTopResults = opts.maxTopResults ?? 5;
  const outputDir =
    opts.outputDir !== undefined
      ? path.resolve(opts.outputDir)
      : path.join(
          process.cwd(),
          ".artifacts",
          "qa-e2e",
          `memory-retrieval-${Date.now().toString(36)}`,
        );
  await fs.mkdir(outputDir, { recursive: true });

  const candidateReports: QaMemoryRetrievalCandidateReport[] = [];
  for (const candidate of candidates) {
    const cases: QaMemoryRetrievalCaseResult[] = [];
    for (const testCase of pack.cases) {
      cases.push(
        await runCandidateCase({
          pack,
          candidate,
          testCase,
          timeoutMs,
          maxTopResults,
        }),
      );
    }
    candidateReports.push({
      ...candidate,
      counts: countStatuses(cases),
      cases,
    });
  }

  const report: QaMemoryRetrievalReport = {
    generatedAt: new Date().toISOString(),
    description: pack.description,
    caseFile,
    candidates: candidateReports,
  };
  const reportPath = path.join(outputDir, "memory-retrieval-report.md");
  const summaryPath = path.join(outputDir, "memory-retrieval-summary.json");
  await fs.writeFile(reportPath, renderQaMemoryRetrievalMarkdownReport(report), "utf8");
  await fs.writeFile(summaryPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { ...report, reportPath, summaryPath };
}
