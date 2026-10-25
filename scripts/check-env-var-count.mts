import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { reportLimitViolations } from "./lib/check-limits.mts";
import {
  loadRatchetReference,
  loadRatchetSnapshot,
  loadRatchetSources,
  parseRatchetArgs,
  parseRatchetScalar,
  resolveRatchetBase,
} from "./lib/shrink-ratchet.mts";

const BUDGET_PATH = "config/env-var-count-budget.txt";
const SOURCE_ROOTS = ["src", "packages", "extensions"];
const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const ENV_VAR_PATTERN = /OPENCLAW_[A-Z0-9_]+/gu;

export function isCountedSourcePath(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/");
  if (!SOURCE_ROOTS.some((root) => normalized.startsWith(root + "/"))) {
    return false;
  }
  if (!SOURCE_EXTENSIONS.has(path.posix.extname(normalized))) {
    return false;
  }
  if (
    /^(?:extensions\/(?:qa-lab|test-support)|.*\/(?:__tests__|test|tests|test-utils|test-support))\//u.test(
      normalized,
    )
  ) {
    return false;
  }
  return !/(?:^|[./-])(?:e2e|live-helpers|live-harness|spec|suite|test|test-helpers|test-harness|test-setup|test-support|test-utils)(?:[./-]|$)/u.test(
    normalized,
  );
}

export type EnvVarNamesByPath = ReadonlyMap<string, ReadonlySet<string>>;

export function addEnvVarNames(source: string, names: Set<string>) {
  for (const match of source.matchAll(ENV_VAR_PATTERN)) {
    names.add(match[0]);
  }
}

export function collectEnvVarNames(
  root = process.cwd(),
  options: { staged?: boolean; preparedNames?: EnvVarNamesByPath } = {},
) {
  const staged = options.staged === true;
  const files = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      ...(staged ? [] : ["--others", "--exclude-standard"]),
      "--",
      ...SOURCE_ROOTS,
    ],
    { cwd: root, maxBuffer: 256 * 1024 * 1024 },
  )
    .toString("utf8")
    .split("\0")
    .filter(isCountedSourcePath)
    .filter((file) => staged || fs.existsSync(path.join(root, file)));
  const sources = staged ? loadRatchetSources(root, files).values() : files;
  const names = new Set<string>();
  for (const entry of sources) {
    const prepared = staged ? undefined : options.preparedNames?.get(entry);
    if (prepared !== undefined) {
      for (const name of prepared) {
        names.add(name);
      }
      continue;
    }
    const source = staged ? entry : fs.readFileSync(path.join(root, entry), "utf8");
    addEnvVarNames(source, names);
  }
  return [...names].toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function parseBudget(source: string) {
  return parseRatchetScalar(source, BUDGET_PATH);
}

export function main(
  argv: string[] = process.argv.slice(2),
  root = process.cwd(),
  preparedNames?: EnvVarNamesByPath,
) {
  const args = parseRatchetArgs(argv);
  if (args.prune) {
    throw new Error("The env-var budget must be updated explicitly; --prune is not supported.");
  }
  const { staged } = args;
  const budget = loadRatchetSnapshot(root, BUDGET_PATH, staged, parseBudget);
  // Staging selects the source/budget snapshot, not the allowed budget: that
  // still belongs to the origin/main fork unless the caller supplies a base.
  const baseRef = resolveRatchetBase(root, {
    ...args,
    base: args.base ?? "origin/main",
    staged: false,
  });
  if (!baseRef) {
    throw new Error("Could not resolve env-var count budget base");
  }
  const baseBudget = loadRatchetReference(root, baseRef, BUDGET_PATH, parseBudget);
  const growth =
    baseBudget !== null && budget > baseBudget
      ? [
          {
            file: BUDGET_PATH,
            title: "Environment variable count budget",
            message: `OPENCLAW_* budget grew from ${baseBudget} to ${budget}`,
          },
        ]
      : [];
  if (reportLimitViolations(growth)) {
    throw new Error(growth[0]!.message);
  }
  const names = collectEnvVarNames(root, { staged, preparedNames });
  // The budget must describe the tree in CI too, so unrecorded names cannot reach main
  // and fail every later local run. Recorded growth follows the limit severity policy.
  if (names.length !== budget) {
    throw new Error(
      `OPENCLAW_* count ${names.length} ${names.length < budget ? "is below" : "exceeds"} budget ${budget}; update ${BUDGET_PATH}`,
    );
  }
  if (growth.length === 0) {
    console.log(`OPENCLAW_* count ${names.length}/${budget}`);
  }
  return names.length;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
