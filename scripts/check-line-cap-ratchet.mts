import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import type { OxlintConfig } from "oxlint";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { resolveRepoToolBinPath } from "./lib/local-check-runtime.mts";
import { createManagedCommandInvocation } from "./lib/managed-child-process.mts";
import {
  compareRatchetCounts,
  listRatchetRenames,
  loadRatchetSnapshot,
  loadRatchetSources,
  parseRatchetArgs,
  reportRatchetFailures,
  reportRatchetSuccess,
  resolveRatchetBase,
} from "./lib/shrink-ratchet.mts";

export type LineCapViolation = { count: number; cap: number };
type OxlintDiagnostic = {
  code?: string;
  filename: string;
  message: string;
  help?: string;
};

export function compareLineCapViolations(
  head: ReadonlyMap<string, LineCapViolation>,
  base: ReadonlyMap<string, LineCapViolation>,
  renames: readonly { from: string; to: string }[] = [],
) {
  const oldPaths = new Map(renames.map(({ from, to }) => [to, from]));
  return compareRatchetCounts(
    new Map([...head].map(([file, { count }]) => [file, count])),
    new Map(
      [...head].map(([file, { cap }]) => [
        file,
        Math.max(cap, base.get(oldPaths.get(file) ?? file)?.count ?? 0),
      ]),
    ),
  ).increased;
}

function gitPaths(root: string, args: string[]) {
  return execFileSync("git", args, { cwd: root, maxBuffer: 256 * 1024 * 1024 })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function collectViolations(
  snapshot: string,
  sources: ReadonlyMap<string, string>,
  config: OxlintConfig,
) {
  const violations = new Map<string, LineCapViolation>();
  if (sources.size === 0) {
    return violations;
  }
  fs.mkdirSync(snapshot, { recursive: true });
  fs.writeFileSync(path.join(snapshot, ".oxlintrc.json"), JSON.stringify(config));
  for (const [file, source] of sources) {
    const target = path.join(snapshot, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Measurement includes inherited suppressed debt. Neutralize directive tokens
    // only in these copies, preserving every byte position and line/comment boundary.
    fs.writeFileSync(
      target,
      source.replace(
        /\b(?:oxlint|eslint)-(?:disable|enable)\b/gu,
        (directive) => directive.slice(0, -1) + "_",
      ),
    );
  }
  const invocation = createManagedCommandInvocation({
    bin: resolveRepoToolBinPath("oxlint", { cwd: path.resolve(import.meta.dirname, "..") }),
    args: [
      "--config",
      ".oxlintrc.json",
      "--disable-nested-config",
      "--no-error-on-unmatched-pattern",
      "--format",
      "json",
      "--threads=1",
      ".",
    ],
  });
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: snapshot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: invocation.shell,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw result.error ?? new Error(result.stderr || "oxlint line-cap probe failed");
  }
  const report: { diagnostics: OxlintDiagnostic[] } = JSON.parse(result.stdout);
  for (const diagnostic of report.diagnostics) {
    if (diagnostic.code !== "eslint(max-lines)") {
      throw new Error(`Cannot measure ${diagnostic.filename}: ${diagnostic.message}`);
    }
    const count = Number(/^File has too many lines \((\d+)\)\.$/u.exec(diagnostic.message)?.[1]);
    const cap = Number(/^Maximum allowed is (\d+)\.$/u.exec(diagnostic.help ?? "")?.[1]);
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(cap)) {
      throw new Error("Unrecognized oxlint max-lines diagnostic: " + diagnostic.message);
    }
    violations.set(diagnostic.filename.replaceAll("\\", "/"), { count, cap });
  }
  if (result.status !== 0 && violations.size === 0) {
    throw new Error(result.stderr || "oxlint failed without line-cap diagnostics");
  }
  return violations;
}

export function main(root = process.cwd(), argv = process.argv.slice(2)) {
  let scratch: string | undefined;
  try {
    const args = parseRatchetArgs(argv);
    if (args.prune) {
      throw new Error("Line caps have no baseline to prune; extract a coherent sibling module.");
    }
    const base = resolveRatchetBase(root, args);
    if (!base) {
      throw new Error("Line-cap ratchet requires a Git base commit.");
    }
    const changes = gitPaths(root, [
      "diff",
      "--name-only",
      "-z",
      "--diff-filter=ACMR",
      "--find-renames",
      ...(args.staged ? ["--cached"] : []),
      base,
    ]);
    if (!args.staged) {
      changes.push(...gitPaths(root, ["ls-files", "--others", "--exclude-standard", "-z"]));
    }
    const paths = [...new Set(changes)].filter((file) => /\.(?:ts|tsx|mts|mjs)$/u.test(file));
    const renames = listRatchetRenames(root, base, args.staged, []);
    const oldPaths = new Map(renames.map(({ from, to }) => [to, from]));
    const basePaths = new Set(gitPaths(root, ["ls-tree", "-r", "--name-only", "-z", base]));
    const baseSources = loadRatchetSources(
      root,
      paths.map((file) => oldPaths.get(file) ?? file).filter((file) => basePaths.has(file)),
      base,
    );
    const headSources = args.staged
      ? loadRatchetSources(root, paths)
      : new Map(paths.map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]));
    const sourceConfig = loadRatchetSnapshot(root, ".oxlintrc.json", args.staged, (source) =>
      JSON5.parse<OxlintConfig>(source),
    );
    const config = {
      categories: { correctness: "off" as const },
      ignorePatterns: sourceConfig.ignorePatterns,
      overrides: sourceConfig.overrides?.flatMap((override) => {
        const rule = override.rules?.["max-lines"];
        return rule === undefined
          ? []
          : [
              {
                files: override.files,
                excludeFiles: override.excludeFiles,
                rules: { "max-lines": rule },
              },
            ];
      }),
    };
    if (!config.overrides?.length) {
      throw new Error("No max-lines overrides found in .oxlintrc.json");
    }
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-line-cap-"));
    const before = collectViolations(path.join(scratch, "base"), baseSources, config);
    const after = collectViolations(path.join(scratch, "head"), headSources, config);
    const increased = compareLineCapViolations(after, before, renames);
    if (
      reportRatchetFailures(
        [
          {
            title: "Line-cap ratchet rejects new violations or growth:",
            entries: increased.map(
              ({ entry, allowed, current }) =>
                `${entry}: ${allowed} -> ${current} counted lines (cap ${after.get(entry)!.cap})`,
            ),
          },
        ],
        "Extract a coherent sibling module; never trim coverage or disable max-lines.",
      )
    ) {
      return 1;
    }
    reportRatchetSuccess(
      `Line-cap ratchet OK: ${paths.length} changed source files; no new violations or over-cap growth.`,
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    if (scratch) {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
