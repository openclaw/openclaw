import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript/unstable/ast";
import {
  createNativeTypeScriptParser,
  type NativeTypeScriptParser,
} from "./lib/native-typescript.mts";
import { loadRatchetSources, runPerFileCountRatchet } from "./lib/shrink-ratchet.mts";

const BASELINE_PATH = "config/test-timeout-race-baseline.txt";
const BASELINE_HEADER = [
  "# Per-file identifier references to withTestTimeout/raceWithTimeoutResult and imported aliases.",
  "# Import specifiers and the helper owner test/helpers/promise.ts are excluded.",
  "# Ratchet: counts may only shrink. New wall-clock test deadlines are not allowed.",
  "# Format: repo-relative path, tab, positive count. Zero-count files are omitted.",
  "",
].join("\n");
const TIMEOUT_NAMES = new Set(["withTestTimeout", "raceWithTimeoutResult"]);
const CODE_EXTENSION_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

function isGovernedSourcePath(filePath: string) {
  return (
    filePath !== "test/helpers/promise.ts" &&
    CODE_EXTENSION_RE.test(filePath) &&
    !/\.d\.[cm]?ts$/u.test(filePath)
  );
}

export function countTestTimeoutRaceReferences(
  filePath: string,
  sourceFile: ts.SourceFile,
  parser: NativeTypeScriptParser,
) {
  const diagnostic = parser.getSyntacticDiagnostics(sourceFile.fileName)[0];
  if (diagnostic) {
    const line = sourceFile.getLineAndCharacterOfPosition(diagnostic.pos).line + 1;
    throw new Error(`${filePath}:${line}: ${diagnostic.text}`);
  }
  const names = new Set(TIMEOUT_NAMES);
  const collectAliases = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) && TIMEOUT_NAMES.has((node.propertyName ?? node.name).text)) {
      names.add(node.name.text);
    }
    node.forEachChild(collectAliases);
  };
  collectAliases(sourceFile);

  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node)) {
      return;
    }
    // Count every reference so aliases, re-exports, and local copies cannot hide a deadline.
    if (ts.isIdentifier(node) && names.has(node.text)) {
      count += 1;
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return count;
}

function collectTestTimeoutRaceCounts(root: string, options: { staged: boolean }) {
  const result = spawnSync(
    "git",
    [
      "grep",
      "-l",
      "-z",
      "-F",
      ...(options.staged ? ["--cached"] : ["--untracked"]),
      "-e",
      "withTestTimeout",
      "-e",
      "raceWithTimeoutResult",
      "--",
      ".",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr.trim() || `git grep failed (${result.status})`);
  }
  const filePaths = result.stdout.split("\0").filter(isGovernedSourcePath).toSorted();
  const sources = options.staged
    ? loadRatchetSources(root, filePaths)
    : filePaths.map((filePath): [string, string] => [
        filePath,
        fs.readFileSync(path.join(root, filePath), "utf8"),
      ]);
  using parser = createNativeTypeScriptParser({ cwd: root });
  const counts = new Map<string, number>();
  for (const [filePath, source] of sources) {
    const count = countTestTimeoutRaceReferences(
      filePath,
      parser.parseSourceFile(filePath, source),
      parser,
    );
    if (count > 0) {
      counts.set(filePath, count);
    }
  }
  return counts;
}

export function main(root = process.cwd(), argv: string[] = process.argv.slice(2)) {
  using parser = createNativeTypeScriptParser({ cwd: root });
  return runPerFileCountRatchet(root, argv, {
    baselinePath: BASELINE_PATH,
    baselineHeader: BASELINE_HEADER,
    renameSourceRoots: ["."],
    collectCurrent: (options) => collectTestTimeoutRaceCounts(root, options),
    countAtRef(ref, filePath) {
      const source = execFileSync("git", ["show", `${ref}:${filePath}`], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: GIT_MAX_BUFFER,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return countTestTimeoutRaceReferences(
        filePath,
        parser.parseSourceFile(filePath, source),
        parser,
      );
    },
    messages: {
      increaseTitle: "Wall-clock test timeout races exceed the grandfathered per-file baseline:",
      expansionTitle: "The test timeout race baseline may only shrink:",
      guidance:
        "New wall-clock test deadlines are not allowed (docs/help/testing/writing-tests.md: Cost budget, Flake triage).\n" +
        "Instead of withTestTimeout/raceWithTimeoutResult or a local copy, wait for the owned completion signal:\n" +
        "awaitGateBeforeSettlement(gate, operation, message) or withinTest(work, signal) from test/helpers/promise.ts,\n" +
        "or vi.useFakeTimers() driven through the owner's injected clock seam.",
      countNoun: "sites",
      successTitle: "test timeout race ratchet OK",
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
