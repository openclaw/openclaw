// Enforces the TypeScript file-size ceiling while grandfathering the existing backlog.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_BASELINE_PATH = "scripts/ts-max-loc-baseline.json";

function writeStdoutLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

export type ParsedArgs = {
  baseRef?: string;
  baselinePath: string;
  maxLines: number;
  writeBaseline: boolean;
};

export function parseArgs(argv: string[]): ParsedArgs {
  let baseRef: string | undefined;
  let baselinePath = DEFAULT_BASELINE_PATH;
  let maxLines = 500;
  let writeBaseline = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--max") {
      const next = argv[index + 1];
      if (!next || !/^\d+$/u.test(next)) {
        throw new Error("--max requires a positive integer");
      }
      maxLines = Number(next);
      if (!Number.isSafeInteger(maxLines) || maxLines <= 0) {
        throw new Error("--max requires a positive integer");
      }
      index++;
      continue;
    }
    if (arg === "--baseline") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("--baseline requires a path");
      }
      baselinePath = next;
      index++;
      continue;
    }
    if (arg === "--base-ref") {
      const next = argv[index + 1];
      if (!next || next.startsWith("-") || !/^[A-Za-z0-9_./-]+$/u.test(next)) {
        throw new Error("--base-ref requires a git ref");
      }
      baseRef = next;
      index++;
      continue;
    }
    if (arg === "--write-baseline") {
      writeBaseline = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { baseRef, baselinePath, maxLines, writeBaseline };
}

function gitLsFilesAll(): string[] {
  // Include untracked files too so local refactors do not pass by accident.
  const stdout = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function isProductionTypeScriptFile(filePath: string): boolean {
  return (
    /\.(?:ts|tsx|mts|cts)$/u.test(filePath) &&
    !/(^|\/)(test|tests|__tests__|test-helpers?|test-support)(\/|$)|\.(test|spec|suite)\.[cm]?tsx?$|(?:^|[/.-])test-(?:helpers?|support|harness)(?:[/.-]|$)/u.test(
      filePath,
    )
  );
}

export function countPhysicalLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  const splitCount = content.split("\n").length;
  return content.endsWith("\n") ? splitCount - 1 : splitCount;
}

export function splitNullDelimitedPaths(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

async function countLines(filePath: string): Promise<number> {
  const content = await readFile(filePath, "utf8");
  return countPhysicalLines(content);
}

type LocResult = {
  filePath: string;
  lines: number;
};

type LocBaseline = Record<string, number>;

export type LocRatchetViolation = LocResult & {
  baselineLines?: number;
  reason: "baseline-missing" | "baseline-stale" | "grew";
};

export function findLocRatchetViolations(params: {
  baseline: LocBaseline;
  maxLines: number;
  results: LocResult[];
}): LocRatchetViolation[] {
  const currentByPath = new Map(params.results.map((result) => [result.filePath, result.lines]));
  const violations: LocRatchetViolation[] = [];

  for (const result of params.results) {
    const baselineLines = params.baseline[result.filePath];
    if (result.lines <= params.maxLines) {
      if (baselineLines !== undefined) {
        violations.push({ ...result, baselineLines, reason: "baseline-stale" });
      }
      continue;
    }
    if (baselineLines === undefined) {
      violations.push({ ...result, reason: "baseline-missing" });
    } else if (result.lines > baselineLines) {
      violations.push({ ...result, baselineLines, reason: "grew" });
    } else if (result.lines < baselineLines) {
      // Require the baseline to move down with every successful split.
      violations.push({ ...result, baselineLines, reason: "baseline-stale" });
    }
  }

  for (const [filePath, baselineLines] of Object.entries(params.baseline)) {
    if (!currentByPath.has(filePath)) {
      violations.push({ filePath, lines: 0, baselineLines, reason: "baseline-stale" });
    }
  }

  return violations.toSorted(
    (left, right) => right.lines - left.lines || left.filePath.localeCompare(right.filePath),
  );
}

export function findVersionedBaselineViolations(params: {
  baseline: LocBaseline;
  baseBaseline: LocBaseline;
  baseLinesByChangedPath: ReadonlyMap<string, number | undefined>;
}): LocRatchetViolation[] {
  const violations: LocRatchetViolation[] = [];
  for (const [filePath, lines] of Object.entries(params.baseline)) {
    if (!params.baseLinesByChangedPath.has(filePath)) {
      // Unchanged source may reconcile base drift; the current-tree check below still requires
      // this baseline to equal the file's actual LOC, so arbitrary inflation remains stale.
      continue;
    }
    const baseLines = params.baseLinesByChangedPath.get(filePath);
    if (baseLines === undefined && params.baseBaseline[filePath] === undefined) {
      violations.push({ filePath, lines, reason: "baseline-missing" });
    } else if (baseLines === undefined || lines > baseLines) {
      violations.push({ filePath, lines, baselineLines: baseLines ?? 0, reason: "grew" });
    }
  }
  return violations.toSorted(
    (left, right) => right.lines - left.lines || left.filePath.localeCompare(right.filePath),
  );
}

export function filterPreexistingBaseDriftViolations(params: {
  baseline: LocBaseline;
  baseBaseline: LocBaseline;
  changedPaths: ReadonlySet<string>;
  violations: LocRatchetViolation[];
}): LocRatchetViolation[] {
  return params.violations.filter(
    (violation) =>
      params.changedPaths.has(violation.filePath) ||
      params.baseline[violation.filePath] !== params.baseBaseline[violation.filePath],
  );
}

async function readBaseline(filePath: string): Promise<LocBaseline> {
  return parseBaseline(await readFile(filePath, "utf8"), filePath);
}

function parseBaseline(content: string, source: string): LocBaseline {
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid TypeScript LOC baseline: ${source}`);
  }
  const baseline: LocBaseline = {};
  for (const [entryPath, value] of Object.entries(parsed)) {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
      throw new Error(`Invalid TypeScript LOC baseline entry: ${entryPath}`);
    }
    baseline[entryPath] = value as number;
  }
  return baseline;
}

function tryGitOutput(args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function resolveComparisonBaseRef(
  baselinePath: string,
  explicitBaseRef?: string,
): string | undefined {
  if (explicitBaseRef) {
    return explicitBaseRef;
  }
  const head = tryGitOutput(["rev-parse", "HEAD"]);
  const mergeBase = tryGitOutput(["merge-base", "HEAD", "origin/main"]);
  if (mergeBase && mergeBase !== head) {
    return mergeBase;
  }
  const changedBaselinePath = tryGitOutput(["diff", "--name-only", "HEAD", "--", baselinePath]);
  if (changedBaselinePath?.split("\n").includes(baselinePath)) {
    return "HEAD";
  }
  return tryGitOutput(["rev-parse", "--verify", "HEAD^"]) ? "HEAD^" : undefined;
}

function readBaselineAtRef(
  baseRef: string | undefined,
  baselinePath: string,
): LocBaseline | undefined {
  if (!baseRef) {
    return undefined;
  }
  if (!tryGitOutput(["rev-parse", "--verify", `${baseRef}^{commit}`])) {
    throw new Error(`Invalid TypeScript LOC comparison ref: ${baseRef}`);
  }
  const content = tryGitOutput(["show", `${baseRef}:${baselinePath}`]);
  return content === undefined ? undefined : parseBaseline(content, `${baseRef}:${baselinePath}`);
}

function readFileAtRef(baseRef: string, filePath: string): string | undefined {
  try {
    return execFileSync("git", ["show", `${baseRef}:${filePath}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

function readChangedPaths(baseRef: string): ReadonlySet<string> {
  const changedPaths = new Set(
    splitNullDelimitedPaths(
      execFileSync("git", ["diff", "--name-only", "-z", baseRef, "--"], {
        encoding: "utf8",
      }),
    ),
  );
  for (const filePath of splitNullDelimitedPaths(
    execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      encoding: "utf8",
    }),
  )) {
    changedPaths.add(filePath);
  }
  return changedPaths;
}

function readBaseLinesForChangedBaselinePaths(
  baseRef: string,
  baseline: LocBaseline,
  changedPaths: ReadonlySet<string>,
): ReadonlyMap<string, number | undefined> {
  const baseLinesByChangedPath = new Map<string, number | undefined>();
  for (const filePath of Object.keys(baseline)) {
    if (!changedPaths.has(filePath)) {
      continue;
    }
    const baseContent = readFileAtRef(baseRef, filePath);
    baseLinesByChangedPath.set(
      filePath,
      baseContent === undefined ? undefined : countPhysicalLines(baseContent),
    );
  }
  return baseLinesByChangedPath;
}

function buildBaseline(results: LocResult[], maxLines: number): LocBaseline {
  return Object.fromEntries(
    results
      .filter((result) => result.lines > maxLines)
      .toSorted((left, right) => left.filePath.localeCompare(right.filePath))
      .map((result) => [result.filePath, result.lines]),
  );
}

function reportViolations(violations: LocRatchetViolation[]): void {
  for (const violation of violations) {
    writeStdoutLine(
      `${violation.lines}\t${violation.baselineLines ?? "-"}\t${violation.reason}\t${violation.filePath}`,
    );
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  });

  const { baseRef, baselinePath, maxLines, writeBaseline } = parseArgs(argv);
  const files = gitLsFilesAll()
    .filter((filePath) => existsSync(filePath))
    .filter(isProductionTypeScriptFile);
  const results = await Promise.all(
    files.map(async (filePath) => ({ filePath, lines: await countLines(filePath) })),
  );

  if (writeBaseline) {
    const comparisonBaseRef = resolveComparisonBaseRef(baselinePath, baseRef);
    if (!comparisonBaseRef) {
      throw new Error("Unable to resolve a comparison ref for the TypeScript LOC baseline update");
    }
    const baseBaseline = readBaselineAtRef(comparisonBaseRef, baselinePath);
    const updatedBaseline = buildBaseline(results, maxLines);
    const changedPaths = readChangedPaths(comparisonBaseRef);
    // A missing baseline at a valid base ref is the one-time initialization path.
    const violations = baseBaseline
      ? findVersionedBaselineViolations({
          baseline: updatedBaseline,
          baseBaseline,
          baseLinesByChangedPath: readBaseLinesForChangedBaselinePaths(
            comparisonBaseRef,
            updatedBaseline,
            changedPaths,
          ),
        })
      : [];
    reportViolations(violations);
    if (violations.length > 0) {
      return 1;
    }
    await writeFile(baselinePath, `${JSON.stringify(updatedBaseline, null, 2)}\n`, "utf8");
    writeStdoutLine(`updated ${baselinePath} (${Object.keys(updatedBaseline).length} files)`);
    return 0;
  }

  const baseline = await readBaseline(baselinePath);
  const comparisonBaseRef = resolveComparisonBaseRef(baselinePath, baseRef);
  const baseBaseline = readBaselineAtRef(comparisonBaseRef, baselinePath);
  const changedPaths = comparisonBaseRef ? readChangedPaths(comparisonBaseRef) : new Set<string>();
  const currentViolations = findLocRatchetViolations({ baseline, maxLines, results });
  const violations = [
    ...(baseBaseline && comparisonBaseRef
      ? findVersionedBaselineViolations({
          baseline,
          baseBaseline,
          baseLinesByChangedPath: readBaseLinesForChangedBaselinePaths(
            comparisonBaseRef,
            baseline,
            changedPaths,
          ),
        })
      : []),
    ...(baseBaseline
      ? filterPreexistingBaseDriftViolations({
          baseline,
          baseBaseline,
          changedPaths,
          violations: currentViolations,
        })
      : currentViolations),
  ];
  reportViolations(violations);
  return violations.length === 0 ? 0 : 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    const exitCode = await main();
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
