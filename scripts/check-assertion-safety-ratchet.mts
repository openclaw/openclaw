import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript/unstable/ast";
import {
  createNativeTypeScriptParser,
  type NativeTypeScriptParser,
} from "./lib/native-typescript.mts";
import {
  loadRatchetSources,
  parseRatchetCounts,
  runPerFileCountRatchet,
} from "./lib/shrink-ratchet.mts";
import {
  TYPE_ASSERTION_PRODUCTION_ROOTS,
  isSkippedTypeAssertionTestPath,
  pathMatchesTypeAssertionRoot,
} from "./lib/type-assertion-guard-scope.mjs";

const BASELINE_PATH = "config/assertion-safety-baseline.txt";
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const BASELINE_HEADER = [
  "# Per-file counts of production type assertions without a // SAFETY: invariant.",
  "# Ratchet: counts may only shrink. New non-const assertions need a SAFETY comment.",
  "# Format: repo-relative path, tab, positive count. Zero-count files are omitted.",
  "",
].join("\n");

type AssertionNode = ts.AsExpression | ts.TypeAssertion;
type AssertionExemption = "const" | "unknown" | "safety-comment" | null;
type AssertionSite = {
  kind: "as" | "angle";
  start: number;
  end: number;
  line: number;
  column: number;
  exemption: AssertionExemption;
  fingerprint: string;
};
type AssertionFileReport = {
  path: string;
  blob: string | null;
  status: "unvisited" | "parsed" | "parse-error" | "excluded" | "missing";
  exclusion: "declaration" | "test-support" | "outside-scope" | null;
  allowance: number;
  counted: number | null;
  unusedAllowance: number | null;
  sites: AssertionSite[];
  diagnostics: Array<{ line: number; column: number; message: string }>;
};
type AssertionSafetyReport = {
  version: 1;
  source: Record<
    "commit" | "tree" | "baselineBlob" | "packageBlob" | "lockfileBlob",
    string | null
  >;
  tooling: { parserVersion: string | null; nodeVersion: string; sha256: Record<string, string> };
  complete: boolean;
  coverage: {
    discovered: number | null;
    parsed: number;
    failed: number;
    unvisited: number;
    excluded: number;
    missing: number;
  };
  totals: {
    allowances: number | null;
    counted: number | null;
    exempt: number | null;
    unusedAllowance: number | null;
  };
  fingerprintKind: "sha256-assertion-text";
  matching: "not-performed";
  ambiguousFingerprints: Array<{ fingerprint: string; occurrences: number }>;
  files: AssertionFileReport[];
  errors: string[];
};

const compareStrings = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

function isDeclarationFile(filePath: string) {
  return [".d.ts", ".d.mts", ".d.cts"].some((suffix) => filePath.endsWith(suffix));
}

export function isGovernedAssertionSourcePath(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/");
  return (
    TYPE_ASSERTION_PRODUCTION_ROOTS.some((root) =>
      pathMatchesTypeAssertionRoot(normalized, root),
    ) &&
    SOURCE_EXTENSIONS.has(path.posix.extname(normalized)) &&
    !isDeclarationFile(normalized) &&
    !isSkippedTypeAssertionTestPath(normalized)
  );
}

function collectSafetyCommentLines(sourceFile: ts.SourceFile, source: string) {
  // Line text, not token scanning: a raw scanner desyncs on the `}` that ends a
  // template substitution and then misses every later comment in the file.
  const sameLine = new Set<number>();
  const standalone = new Set<number>();
  sourceFile.getLineStarts().forEach((lineStart, line) => {
    const lineEnd = source.indexOf("\n", lineStart);
    const text = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
    const commentStart = text.indexOf("//");
    if (commentStart === -1 || !/^\/\/\s*SAFETY:\s*\S/u.test(text.slice(commentStart).trim())) {
      return;
    }
    sameLine.add(line);
    if (text.slice(0, commentStart).trim() === "") {
      standalone.add(line);
    }
  });
  return { sameLine, standalone };
}

function assertionOperatorPosition(sourceFile: ts.SourceFile, node: AssertionNode) {
  if (ts.isTypeAssertion(node)) {
    return node.getStart(sourceFile);
  }
  const scanner = ts.createScanner(
    true,
    sourceFile.languageVariant,
    sourceFile.text,
    node.expression.end,
    node.type.pos - node.expression.end,
  );
  return scanner.scan() === ts.SyntaxKind.AsKeyword
    ? scanner.getTokenStart()
    : node.getStart(sourceFile);
}

export function countUnsafeAssertions(
  source: string,
  filePath: string,
  sourceFile: ts.SourceFile,
  parser: NativeTypeScriptParser,
) {
  const repoPath = filePath.replaceAll("\\", "/");
  if (isDeclarationFile(repoPath)) {
    return 0;
  }
  const diagnostic = parser.getSyntacticDiagnostics(sourceFile.fileName)[0];
  if (diagnostic) {
    const position = diagnostic.pos;
    const line = sourceFile.getLineAndCharacterOfPosition(position).line + 1;
    throw new Error(`${filePath}:${line}: ${diagnostic.text}`);
  }
  return scanAssertionNodes(source, sourceFile);
}

function scanAssertionNodes(
  source: string,
  sourceFile: ts.SourceFile,
  observe?: (node: AssertionNode, exemption: AssertionExemption) => void,
) {
  const safetyCommentLines = collectSafetyCommentLines(sourceFile, source);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) || ts.isTypeAssertion(node)) {
      const isConstAssertion =
        ts.isTypeReferenceNode(node.type) &&
        ts.isIdentifier(node.type.typeName) &&
        node.type.typeName.text === "const" &&
        !node.type.typeArguments;
      let exemption: AssertionExemption = isConstAssertion ? "const" : null;
      // Casting exactly to unknown strengthens evidence; oxlint rejects chained assertions.
      if (!isConstAssertion && node.type.kind === ts.SyntaxKind.UnknownKeyword) {
        exemption = "unknown";
      } else if (!isConstAssertion) {
        const operatorLine = sourceFile.getLineAndCharacterOfPosition(
          assertionOperatorPosition(sourceFile, node),
        ).line;
        if (
          safetyCommentLines.sameLine.has(operatorLine) ||
          safetyCommentLines.standalone.has(operatorLine - 1)
        ) {
          exemption = "safety-comment";
        }
      }
      if (exemption === null) {
        count += 1;
      }
      observe?.(node, exemption);
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return count;
}

export function collectCurrentAssertionSafetyCounts(
  root = process.cwd(),
  options: { staged?: boolean } = {},
) {
  using parser = createNativeTypeScriptParser({ cwd: root });
  const staged = options.staged === true;
  const filePaths = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      ...(staged ? ["--cached"] : ["--cached", "--others", "--exclude-standard"]),
      "--",
      ...TYPE_ASSERTION_PRODUCTION_ROOTS,
    ],
    { cwd: root, maxBuffer: GIT_MAX_BUFFER },
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter(isGovernedAssertionSourcePath)
    .filter((filePath) => staged || fs.existsSync(path.join(root, filePath)))
    .toSorted(compareStrings);
  const sources = staged
    ? [...loadRatchetSources(root, filePaths)]
    : filePaths.map((filePath): [string, string] => [
        filePath,
        fs.readFileSync(path.join(root, filePath), "utf8"),
      ]);
  const counts = new Map<string, number>();
  const batchSize = 32;
  for (let offset = 0; offset < sources.length;) {
    const batch: Array<{ fileName: string; text: string }> = [];
    const names = new Set<string>();
    while (batch.length < batchSize && offset + batch.length < sources.length) {
      const [filePath, text] = sources[offset + batch.length]!;
      const fileName = path.resolve(root, filePath).split(path.sep).join("/");
      // An unmerged index repeats paths; preserve each visit without duplicating a parser root.
      if (names.has(fileName)) {
        break;
      }
      names.add(fileName);
      batch.push({ fileName, text });
    }
    for (const [index, sourceFile] of parser.parseSourceFiles(batch).entries()) {
      const [filePath, source] = sources[offset + index]!;
      const count = countUnsafeAssertions(source, filePath, sourceFile, parser);
      if (count > 0) {
        counts.set(filePath, count);
      }
    }
    offset += batch.length;
  }
  return counts;
}

function sha256(source: string | Buffer) {
  return createHash("sha256").update(source).digest("hex");
}

/** Report one immutable source tree with the policy and parser executing this scan. */
export function collectAssertionSafetyReport(root: string, ref: string) {
  const report: AssertionSafetyReport = {
    version: 1,
    source: {
      commit: null,
      tree: null,
      baselineBlob: null,
      packageBlob: null,
      lockfileBlob: null,
    },
    tooling: {
      parserVersion: null,
      nodeVersion: process.versions.node,
      sha256: {},
    },
    complete: false,
    coverage: { discovered: null, parsed: 0, failed: 0, unvisited: 0, excluded: 0, missing: 0 },
    totals: { allowances: null, counted: null, exempt: null, unusedAllowance: null },
    fingerprintKind: "sha256-assertion-text",
    matching: "not-performed",
    ambiguousFingerprints: [],
    files: [],
    errors: [],
  };
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER });
  try {
    for (const file of [
      "check-assertion-safety-ratchet.mts",
      "lib/native-typescript.mts",
      "lib/shrink-ratchet.mts",
      "lib/type-assertion-guard-scope.mjs",
    ]) {
      report.tooling.sha256[`scripts/${file}`] = sha256(
        fs.readFileSync(new URL(file, import.meta.url)),
      );
    }
    const require = createRequire(import.meta.url);
    const manifest: unknown = JSON.parse(
      fs.readFileSync(require.resolve("typescript/package.json"), "utf8"),
    );
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      !("version" in manifest) ||
      typeof manifest.version !== "string"
    ) {
      throw new Error("Installed TypeScript package has no version");
    }
    report.tooling.parserVersion = manifest.version;
    const commit = git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
    report.source.commit = commit;
    report.source.tree = git(["rev-parse", `${commit}^{tree}`]).trim();
    const entries = new Map<string, { mode: string; blob: string }>();
    for (const entry of git(["ls-tree", "-r", "-z", commit]).split("\0").filter(Boolean)) {
      const separator = entry.indexOf("\t");
      const [mode, , blob] = entry.slice(0, separator).split(" ");
      if (separator < 0 || !mode || !blob) {
        throw new Error("Invalid git ls-tree source inventory");
      }
      entries.set(entry.slice(separator + 1), { mode, blob });
    }
    report.source.baselineBlob = entries.get(BASELINE_PATH)?.blob ?? null;
    report.source.packageBlob = entries.get("package.json")?.blob ?? null;
    report.source.lockfileBlob = entries.get("pnpm-lock.yaml")?.blob ?? null;
    const baseline = parseRatchetCounts(git(["show", `${commit}:${BASELINE_PATH}`]), BASELINE_PATH);
    report.totals.allowances = [...baseline.values()].reduce((total, count) => total + count, 0);
    const paths = new Set([
      ...[...entries.keys()].filter(
        (file) =>
          TYPE_ASSERTION_PRODUCTION_ROOTS.some((sourceRoot) =>
            pathMatchesTypeAssertionRoot(file, sourceRoot),
          ) && SOURCE_EXTENSIONS.has(path.posix.extname(file)),
      ),
      ...baseline.keys(),
    ]);
    report.files = [...paths].toSorted(compareStrings).map((file): AssertionFileReport => {
      const entry = entries.get(file);
      const governed = isGovernedAssertionSourcePath(file);
      const allowance = baseline.get(file) ?? 0;
      return {
        path: file,
        blob: entry?.blob ?? null,
        status: !entry ? "missing" : governed ? "unvisited" : "excluded",
        exclusion: governed
          ? null
          : isDeclarationFile(file)
            ? "declaration"
            : isSkippedTypeAssertionTestPath(file)
              ? "test-support"
              : "outside-scope",
        allowance,
        counted: !entry || !governed ? 0 : null,
        unusedAllowance: !entry || !governed ? allowance : null,
        sites: [],
        diagnostics: [],
      };
    });
    report.coverage.discovered = report.files.length;
    const governed = report.files.filter((file) => file.status === "unvisited");
    using parser = createNativeTypeScriptParser({ cwd: root });
    for (let offset = 0; offset < governed.length; offset += 32) {
      const batch = governed.slice(offset, offset + 32);
      for (const file of batch) {
        const mode = entries.get(file.path)?.mode;
        if (mode !== "100644" && mode !== "100755") {
          throw new Error(`Cannot inventory non-regular source: ${file.path}`);
        }
      }
      const sources = loadRatchetSources(
        root,
        batch.map((file) => file.path),
        commit,
      );
      const parsed = parser.parseSourceFiles(
        batch.map((file) => {
          const text = sources.get(file.path);
          if (text === undefined) {
            throw new Error(`Missing source: ${file.path}`);
          }
          return { fileName: file.path, text };
        }),
      );
      for (const [index, sourceFile] of parsed.entries()) {
        const file = batch[index]!;
        file.diagnostics = parser.getSyntacticDiagnostics(sourceFile.fileName).map((diagnostic) => {
          const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.pos);
          return {
            line: position.line + 1,
            column: position.character + 1,
            message: diagnostic.text,
          };
        });
        file.diagnostics.sort(
          (left, right) =>
            left.line - right.line ||
            left.column - right.column ||
            compareStrings(left.message, right.message),
        );
        if (file.diagnostics.length > 0) {
          file.status = "parse-error";
          continue;
        }
        file.counted = scanAssertionNodes(sourceFile.text, sourceFile, (node, exemption) => {
          const start = node.getStart(sourceFile);
          const position = sourceFile.getLineAndCharacterOfPosition(
            assertionOperatorPosition(sourceFile, node),
          );
          file.sites.push({
            kind: ts.isAsExpression(node) ? "as" : "angle",
            start,
            end: node.end,
            line: position.line + 1,
            column: position.character + 1,
            exemption,
            fingerprint: sha256(sourceFile.text.slice(start, node.end)),
          });
        });
        file.sites.sort((left, right) => left.start - right.start || left.end - right.end);
        file.unusedAllowance = Math.max(0, file.allowance - file.counted);
        file.status = "parsed";
      }
    }
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
  }
  const fingerprints = new Map<string, number>();
  let counted = 0;
  let exempt = 0;
  let unusedAllowance = 0;
  for (const file of report.files) {
    report.coverage[file.status === "parse-error" ? "failed" : file.status] += 1;
    counted += file.counted ?? 0;
    unusedAllowance += file.unusedAllowance ?? 0;
    for (const site of file.sites) {
      exempt += site.exemption === null ? 0 : 1;
      fingerprints.set(site.fingerprint, (fingerprints.get(site.fingerprint) ?? 0) + 1);
    }
  }
  // Identical syntax is not a semantic match or evidence that debt was repaired.
  // Keep duplicate hashes visible instead of arbitrarily pairing moved sites.
  report.ambiguousFingerprints = [...fingerprints]
    .filter(([, count]) => count > 1)
    .toSorted(([left], [right]) => compareStrings(left, right))
    .map(([fingerprint, occurrences]) => ({ fingerprint, occurrences }));
  report.complete =
    report.errors.length === 0 && report.coverage.failed === 0 && report.coverage.unvisited === 0;
  if (report.complete) {
    report.totals.counted = counted;
    report.totals.exempt = exempt;
    report.totals.unusedAllowance = unusedAllowance;
  }
  return report;
}

export function main(root = process.cwd(), argv: string[] = process.argv.slice(2)) {
  if (argv[0] === "--report") {
    if (argv.length !== 2 || !argv[1]) {
      console.error("Usage: check:assertion-safety --report <commit-or-ref>");
      return 1;
    }
    const report = collectAssertionSafetyReport(root, argv[1]);
    console.log(JSON.stringify(report, null, 2));
    return report.complete ? 0 : 1;
  }
  using parser = createNativeTypeScriptParser({ cwd: root });
  return runPerFileCountRatchet(root, argv, {
    baselinePath: BASELINE_PATH,
    baselineHeader: BASELINE_HEADER,
    renameSourceRoots: TYPE_ASSERTION_PRODUCTION_ROOTS,
    collectCurrent: (options) => collectCurrentAssertionSafetyCounts(root, options),
    countAtRef(ref, filePath) {
      const source = execFileSync("git", ["show", `${ref}:${filePath}`], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: GIT_MAX_BUFFER,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return countUnsafeAssertions(
        source,
        filePath,
        parser.parseSourceFile(filePath, source),
        parser,
      );
    },
    messages: {
      increaseTitle: "Uncommented type assertions exceed the grandfathered per-file baseline:",
      expansionTitle: "The assertion SAFETY baseline may only shrink:",
      guidance:
        "Every new non-const type assertion needs // SAFETY: <invariant> above it or on the same line.",
      countNoun: "assertions",
      successTitle: "assertion SAFETY ratchet OK",
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
