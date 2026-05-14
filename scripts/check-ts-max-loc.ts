import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function writeStdoutLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

type ParsedArgs = {
  baselinePath?: string;
  json: boolean;
  maxLines: number;
  rootDir: string;
  writeBaseline: boolean;
};

type BaselineEntry =
  | number
  | {
      category?: string;
      lines?: number;
      owner?: string;
      plan?: string;
    };

type NormalizedBaselineEntry = {
  category?: string;
  lines: number;
};

type LocOffender = {
  filePath: string;
  lines: number;
};

type LocBaseline = {
  entries?: Record<string, BaselineEntry>;
  maxLines?: number;
};

export type TsMaxLocCheckResult = {
  baselineEntryCount: number;
  baselinePath?: string;
  baselinedDebtCount: number;
  grownOffenders: Array<LocOffender & { baselineLines: number; category?: string }>;
  maxLines: number;
  newOffenders: LocOffender[];
  ok: boolean;
  oversizedCount: number;
  rootDir: string;
  staleBaselineEntries: Array<{ filePath: string; reason: string }>;
  topDebt: Array<LocOffender & { baselineLines?: number; category?: string }>;
  totalFiles: number;
};

const DEFAULT_BASELINE_RELATIVE_PATH = "scripts/lib/ts-max-loc-baseline.json";
const BASELINE_TOP_DEBT_LIMIT = 20;

export function parseArgs(argv: string[]): ParsedArgs {
  let maxLines = 500;
  let baselinePath: string | undefined;
  let baselineExplicitlyDisabled = false;
  let json = false;
  let rootDir = process.cwd();
  let writeBaseline = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--baseline") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing --baseline value");
      }
      baselinePath = next;
      index++;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--max") {
      const next = argv[index + 1];
      if (!next || Number.isNaN(Number(next))) {
        throw new Error("Missing/invalid --max value");
      }
      maxLines = Number(next);
      index++;
      continue;
    }
    if (arg === "--no-baseline") {
      baselineExplicitlyDisabled = true;
      baselinePath = undefined;
      continue;
    }
    if (arg === "--root") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing --root value");
      }
      rootDir = path.resolve(next);
      index++;
      continue;
    }
    if (arg === "--write-baseline") {
      writeBaseline = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!baselineExplicitlyDisabled && !baselinePath) {
    const defaultBaselinePath = path.join(rootDir, DEFAULT_BASELINE_RELATIVE_PATH);
    if (writeBaseline || existsSync(defaultBaselinePath)) {
      baselinePath = defaultBaselinePath;
    }
  }

  return {
    baselinePath: baselinePath ? path.resolve(rootDir, baselinePath) : undefined,
    json,
    maxLines,
    rootDir,
    writeBaseline,
  };
}

function gitLsFilesAll(rootDir: string): string[] {
  // Include untracked files too so local refactors don’t “pass” by accident.
  const stdout = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: rootDir,
    encoding: "utf8",
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function countLines(rootDir: string, filePath: string): Promise<number> {
  const absolutePath = path.join(rootDir, filePath);
  const content = await readFile(absolutePath, "utf8");
  // Count physical lines. Keeps the rule simple + predictable.
  return content.split("\n").length;
}

export async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex++;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function normalizeRepoPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function normalizeBaselineEntry(entry: BaselineEntry | undefined): NormalizedBaselineEntry | null {
  if (typeof entry === "number" && Number.isFinite(entry)) {
    return { lines: Math.max(0, Math.floor(entry)) };
  }
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const lines = typeof entry.lines === "number" && Number.isFinite(entry.lines)
    ? Math.max(0, Math.floor(entry.lines))
    : 0;
  if (lines <= 0) {
    return null;
  }
  return {
    category: typeof entry.category === "string" ? entry.category : undefined,
    lines,
  };
}

async function loadBaseline(baselinePath: string | undefined): Promise<LocBaseline> {
  if (!baselinePath || !existsSync(baselinePath)) {
    return {};
  }
  const raw = await readFile(baselinePath, "utf8");
  return JSON.parse(raw) as LocBaseline;
}

export async function writeLocBaseline(params: {
  baselinePath: string;
  maxLines: number;
  offenders: readonly LocOffender[];
}): Promise<void> {
  const sortedOffenders = [...params.offenders].toSorted((a, b) => {
    const lineDelta = b.lines - a.lines;
    return lineDelta !== 0 ? lineDelta : a.filePath.localeCompare(b.filePath);
  });
  const entries = Object.fromEntries(
    sortedOffenders.map((offender) => [offender.filePath, offender.lines]),
  );
  const baseline = {
    $schema: "https://openclaw.local/schemas/ts-max-loc-baseline.json",
    description:
      "Existing TypeScript LOC debt baseline. check:loc fails for new oversized files, growth above baseline, or stale entries that should be removed.",
    maxLines: params.maxLines,
    entries,
  };
  await mkdir(path.dirname(params.baselinePath), { recursive: true });
  await writeFile(params.baselinePath, `${JSON.stringify(baseline)}\n`, "utf8");
}

export async function collectTsMaxLocCheck(params: {
  baselinePath?: string;
  maxLines: number;
  rootDir: string;
}): Promise<TsMaxLocCheckResult> {
  const rootDir = path.resolve(params.rootDir);
  const baseline = await loadBaseline(params.baselinePath);
  const baselineEntries = baseline.entries ?? {};
  const files = gitLsFilesAll(rootDir)
    .map(normalizeRepoPath)
    .filter((filePath) => existsSync(path.join(rootDir, filePath)))
    .filter((filePath) => filePath.endsWith(".ts") || filePath.endsWith(".tsx"));

  const results = await mapWithConcurrency(files, 64, async (filePath) => ({
    filePath,
    lines: await countLines(rootDir, filePath),
  }));

  const offenders = results
    .filter((result) => result.lines > params.maxLines)
    .toSorted((a, b) => b.lines - a.lines);
  const offenderByPath = new Map(offenders.map((offender) => [offender.filePath, offender]));

  const newOffenders: LocOffender[] = [];
  const grownOffenders: Array<LocOffender & { baselineLines: number; category?: string }> = [];
  const baselinedDebt: Array<LocOffender & { baselineLines: number; category?: string }> = [];

  for (const offender of offenders) {
    const baselineEntry = normalizeBaselineEntry(baselineEntries[offender.filePath]);
    if (!baselineEntry) {
      newOffenders.push(offender);
      continue;
    }
    if (offender.lines > baselineEntry.lines) {
      grownOffenders.push({
        ...offender,
        baselineLines: baselineEntry.lines,
        category: baselineEntry.category,
      });
      continue;
    }
    baselinedDebt.push({
      ...offender,
      baselineLines: baselineEntry.lines,
      category: baselineEntry.category,
    });
  }

  const staleBaselineEntries = Object.keys(baselineEntries)
    .map(normalizeRepoPath)
    .filter((filePath) => normalizeBaselineEntry(baselineEntries[filePath]))
    .filter((filePath) => !offenderByPath.has(filePath))
    .map((filePath) => ({
      filePath,
      reason: existsSync(path.join(rootDir, filePath))
        ? "file is now at or below the LOC max"
        : "file no longer exists",
    }))
    .toSorted((a, b) => a.filePath.localeCompare(b.filePath));

  const topDebt = [...baselinedDebt]
    .toSorted((a, b) => b.lines - a.lines)
    .slice(0, BASELINE_TOP_DEBT_LIMIT);

  return {
    baselineEntryCount: Object.keys(baselineEntries).length,
    baselinePath: params.baselinePath,
    baselinedDebtCount: baselinedDebt.length,
    grownOffenders,
    maxLines: params.maxLines,
    newOffenders,
    ok:
      newOffenders.length === 0 &&
      grownOffenders.length === 0 &&
      staleBaselineEntries.length === 0,
    oversizedCount: offenders.length,
    rootDir,
    staleBaselineEntries,
    topDebt,
    totalFiles: files.length,
  };
}

function printOffenderSection(title: string, offenders: readonly LocOffender[]): void {
  if (!offenders.length) {
    return;
  }
  writeStdoutLine(title);
  for (const offender of offenders) {
    writeStdoutLine(`${offender.lines}\t${offender.filePath}`);
  }
}

function printGrownOffenderSection(
  title: string,
  offenders: ReadonlyArray<LocOffender & { baselineLines: number }>,
): void {
  if (!offenders.length) {
    return;
  }
  writeStdoutLine(title);
  for (const offender of offenders) {
    writeStdoutLine(`${offender.lines}\t${offender.baselineLines}\t${offender.filePath}`);
  }
}

function printStaleSection(entries: ReadonlyArray<{ filePath: string; reason: string }>): void {
  if (!entries.length) {
    return;
  }
  writeStdoutLine("Stale LOC baseline entries:");
  for (const entry of entries) {
    writeStdoutLine(`${entry.filePath}\t${entry.reason}`);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<TsMaxLocCheckResult> {
  // Makes `... | head` safe.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  });

  const args = parseArgs(argv);
  const result = await collectTsMaxLocCheck(args);
  if (args.writeBaseline) {
    const baselineSource = await collectTsMaxLocCheck({
      maxLines: args.maxLines,
      rootDir: args.rootDir,
    });
    await writeLocBaseline({
      baselinePath: args.baselinePath ?? path.join(args.rootDir, DEFAULT_BASELINE_RELATIVE_PATH),
      maxLines: args.maxLines,
      offenders: baselineSource.newOffenders,
    });
    if (!args.json) {
      writeStdoutLine(`Wrote LOC baseline: ${args.baselinePath}`);
    }
    process.exitCode = 0;
    return result;
  }

  if (args.json) {
    writeStdoutLine(JSON.stringify(result, null, 2));
  } else if (!result.ok) {
    printOffenderSection("New oversized TS files:", result.newOffenders);
    printGrownOffenderSection("LOC growth above baseline:", result.grownOffenders);
    printStaleSection(result.staleBaselineEntries);
  }

  process.exitCode = result.ok ? 0 : 1;
  return result;
}

if (import.meta.main) {
  await main();
}
