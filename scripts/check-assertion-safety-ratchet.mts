import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript/unstable/ast";
import {
  createNativeTypeScriptParser,
  type NativeTypeScriptParser,
} from "./lib/native-typescript.mts";
import { loadRatchetSources, runPerFileCountRatchet } from "./lib/shrink-ratchet.mts";
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

  const safetyCommentLines = collectSafetyCommentLines(sourceFile, source);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) || ts.isTypeAssertion(node)) {
      const isConstAssertion =
        ts.isTypeReferenceNode(node.type) &&
        ts.isIdentifier(node.type.typeName) &&
        node.type.typeName.text === "const" &&
        !node.type.typeArguments;
      // Casting exactly to unknown strengthens evidence; oxlint rejects chained assertions.
      if (!isConstAssertion && node.type.kind !== ts.SyntaxKind.UnknownKeyword) {
        const operatorLine = sourceFile.getLineAndCharacterOfPosition(
          assertionOperatorPosition(sourceFile, node),
        ).line;
        if (
          !safetyCommentLines.sameLine.has(operatorLine) &&
          !safetyCommentLines.standalone.has(operatorLine - 1)
        ) {
          count += 1;
        }
      }
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
  for (const [filePath, source] of sources) {
    const count = countUnsafeAssertions(
      source,
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
