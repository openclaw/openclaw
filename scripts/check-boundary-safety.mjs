#!/usr/bin/env node

// Checks for newly introduced high-risk text and response boundary bypasses.
import { execFileSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  collectTypeScriptFilesFromRoots,
  resolveRepoRoot,
  resolveSourceRoots,
  runAsScript,
  toLine,
  unwrapExpression,
} from "./lib/ts-guard-utils.mjs";

const repoRoot = resolveRepoRoot(import.meta.url);
const baselinePath = path.join(repoRoot, "test", "fixtures", "boundary-safety-inventory.json");
const sourceRoots = resolveSourceRoots(repoRoot, ["src", "extensions", "packages"]);

const responseReadMethods = new Set(["json", "text", "arrayBuffer"]);
const responseReceiverNames = new Set([
  "res",
  "resp",
  "response",
  "providerResponse",
  "httpResponse",
  "fetchResponse",
  "upstreamResponse",
  "remoteResponse",
]);

const textReceiverRe =
  /(?:text|message|summary|preview|snippet|label|title|prompt|context|draft|caption|description|progress|body|output|reason|name)/i;
const textLimitRe = /(?:max|limit|length|chars|size|budget|truncate|preview|summary|snippet)/i;
const textTruncationContextRe =
  /(?:…|\.\.\.|ellipsis|truncated|truncate|preview|summary|label|title|message|prompt|context|snippet|task|progress|caption|description)/i;
const collectionReceiverNames = new Set([
  "attachments",
  "candidateSnippets",
  "entries",
  "imageAttachments",
  "items",
  "labels",
  "messages",
  "pages",
  "parts",
  "snippets",
  "stickers",
  "subMessages",
  "summaries",
  "texts",
  "tokens",
]);
const arrayProducingChainMethods = new Set([
  "concat",
  "filter",
  "flatMap",
  "map",
  "sort",
  "toSorted",
  "values",
]);
const stringProducingChainMethods = new Set([
  "join",
  "normalize",
  "replace",
  "replaceAll",
  "toLocaleLowerCase",
  "toLocaleUpperCase",
  "toLowerCase",
  "toString",
  "toUpperCase",
  "trim",
  "trimEnd",
  "trimStart",
]);
const ignoredPathParts = [
  "/test/",
  "/tests/",
  "/fixtures/",
  "/__fixtures__/",
  "/dist/",
  "/generated/",
  "/node_modules/",
  "/vendor/",
];
const ignoredSuffixes = [
  ".test.ts",
  ".spec.ts",
  ".test.tsx",
  ".spec.tsx",
  ".test-helpers.ts",
  ".test-harness.ts",
  ".e2e-harness.ts",
  ".d.ts",
];

function normalizePath(filePath) {
  return filePath.replaceAll(path.sep, "/");
}

function nodeText(sourceFile, node) {
  return node.getText(sourceFile);
}

function readPropertyAccessCall(node) {
  const expression = unwrapExpression(node.expression);
  if (!ts.isPropertyAccessExpression(expression)) {
    return null;
  }
  return {
    receiver: unwrapExpression(expression.expression),
    name: expression.name.text,
  };
}

function isZeroLiteral(node) {
  const expression = unwrapExpression(node);
  return ts.isNumericLiteral(expression) && expression.text === "0";
}

function isNegativeLiteral(node) {
  const expression = unwrapExpression(node);
  return (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expression.operand)
  );
}

function finalAccessName(node) {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return null;
}

function isStringProducingExpression(sourceFile, node) {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
    const name = finalAccessName(expression);
    return Boolean(name && textReceiverRe.test(name) && !collectionReceiverNames.has(name));
  }
  if (ts.isCallExpression(expression)) {
    const access = readPropertyAccessCall(expression);
    if (access) {
      if (stringProducingChainMethods.has(access.name)) {
        return true;
      }
      if (arrayProducingChainMethods.has(access.name)) {
        return false;
      }
      return isStringProducingExpression(sourceFile, access.receiver);
    }
    return /(?:text|message|summary|snippet|label|title|prompt|caption|description|body|string)/i.test(
      nodeText(sourceFile, expression.expression),
    );
  }
  return false;
}

function nearestBoundaryContextText(sourceFile, node) {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (
      ts.isTemplateExpression(parent) ||
      ts.isNoSubstitutionTemplateLiteral(parent) ||
      ts.isBinaryExpression(parent) ||
      ts.isConditionalExpression(parent) ||
      ts.isReturnStatement(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isPropertyAssignment(parent)
    ) {
      return parent.getText(sourceFile);
    }
    if (ts.isStatement(parent)) {
      return parent.getText(sourceFile);
    }
    current = parent;
  }
  return node.getText(sourceFile);
}

function isLikelyTextBoundarySlice(sourceFile, call) {
  const access = readPropertyAccessCall(call);
  if (!access || (access.name !== "slice" && access.name !== "substring")) {
    return false;
  }
  if (
    call.arguments.length < 2 ||
    !isZeroLiteral(call.arguments[0]) ||
    isNegativeLiteral(call.arguments[1])
  ) {
    return false;
  }

  const limitText = nodeText(sourceFile, call.arguments[1]);
  const contextText = nearestBoundaryContextText(sourceFile, call);

  if (!isStringProducingExpression(sourceFile, access.receiver)) {
    return false;
  }
  return textLimitRe.test(limitText) || textTruncationContextRe.test(contextText);
}

function isResponseReceiver(sourceFile, node) {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    return responseReceiverNames.has(expression.text) || expression.text.endsWith("Response");
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const text = nodeText(sourceFile, expression);
    return /(?:^|\.)(?:res|resp|response|providerResponse|httpResponse|fetchResponse|upstreamResponse|remoteResponse)$/.test(
      text,
    );
  }
  return false;
}

function isAwaitedRead(call) {
  let current = call;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isAwaitExpression(parent)) {
      return true;
    }
    if (
      ts.isExpressionStatement(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isReturnStatement(parent)
    ) {
      return false;
    }
    current = parent;
  }
  return false;
}

function isLikelyResponseBodyRead(sourceFile, call) {
  const access = readPropertyAccessCall(call);
  if (!access || !responseReadMethods.has(access.name)) {
    return false;
  }
  if (!isResponseReceiver(sourceFile, access.receiver)) {
    return false;
  }
  return isAwaitedRead(call);
}

function hasBoundarySafetyIgnore(sourceFile, node, ruleId) {
  const sourceText = sourceFile.getFullText();
  const comments = ts.getLeadingCommentRanges(sourceText, node.getFullStart()) ?? [];
  return comments.some((comment) => {
    const text = sourceText.slice(comment.pos, comment.end);
    return text.includes(`boundary-safety-ignore ${ruleId}:`) && /:\s*\S/.test(text);
  });
}

export function findBoundarySafetyViolations(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const violations = [];

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      if (isLikelyTextBoundarySlice(sourceFile, node)) {
        const ruleId = "boundary/text-utf16-truncation";
        if (!hasBoundarySafetyIgnore(sourceFile, node, ruleId)) {
          violations.push({
            line: toLine(sourceFile, node),
            ruleId,
            match: nodeText(sourceFile, node),
            guidance:
              "Use truncateUtf16Safe(...) for head truncation or sliceUtf16Safe(...) for non-head slicing.",
          });
        }
      }

      if (isLikelyResponseBodyRead(sourceFile, node)) {
        const ruleId = "boundary/response-body-limit";
        if (!hasBoundarySafetyIgnore(sourceFile, node, ruleId)) {
          violations.push({
            line: toLine(sourceFile, node),
            ruleId,
            match: nodeText(sourceFile, node),
            guidance:
              "Use readResponseWithLimit(...), readProviderJsonResponse(...), readResponseTextSnippet(...), or openclaw/plugin-sdk/response-limit-runtime from plugin code.",
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

export function isBoundarySafetyCandidateFile(filePath) {
  const normalized = normalizePath(filePath);
  if (!normalized.endsWith(".ts") && !normalized.endsWith(".tsx")) {
    return false;
  }
  if (ignoredPathParts.some((part) => normalized.includes(part))) {
    return false;
  }
  if (ignoredSuffixes.some((suffix) => normalized.endsWith(suffix))) {
    return false;
  }
  if (normalized === "scripts/check-boundary-safety.mjs") {
    return false;
  }
  return /^(?:src\/|extensions\/|packages\/)/.test(normalized);
}

function entryKey(entry) {
  return `${entry.ruleId}:${normalizePath(entry.file)}:${entry.line}:${entry.match}`;
}

export function diffBoundaryInventory(expected, actual) {
  const expectedKeys = new Set(expected.map(entryKey));
  const actualKeys = new Set(actual.map(entryKey));
  return {
    missing: expected.filter((entry) => !actualKeys.has(entryKey(entry))),
    unexpected: actual.filter((entry) => !expectedKeys.has(entryKey(entry))),
  };
}

function sortInventory(entries) {
  return entries.toSorted((a, b) => {
    const fileCmp = a.file.localeCompare(b.file);
    if (fileCmp !== 0) {
      return fileCmp;
    }
    const lineCmp = a.line - b.line;
    if (lineCmp !== 0) {
      return lineCmp;
    }
    return a.ruleId.localeCompare(b.ruleId) || a.match.localeCompare(b.match);
  });
}

async function readBaseline() {
  try {
    return JSON.parse(await fs.readFile(baselinePath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function runGit(args) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function collectChangedFileNames() {
  const names = new Set();
  for (const output of [
    runGit(["diff", "--name-only", "--diff-filter=ACMRTUXB", "HEAD", "--"]),
    runGit(["diff", "--cached", "--name-only", "--diff-filter=ACMRTUXB", "--"]),
    runGit(["diff", "--name-only", "--diff-filter=ACMRTUXB", "origin/main...HEAD", "--"]),
    runGit(["ls-files", "--others", "--exclude-standard"]),
  ]) {
    for (const line of output.split("\n")) {
      const file = line.trim();
      if (file) {
        names.add(normalizePath(file));
      }
    }
  }
  return [...names];
}

async function collectAllCandidateFiles() {
  const files = await collectTypeScriptFilesFromRoots(sourceRoots, { includeTests: false });
  return files
    .map((filePath) => normalizePath(path.relative(repoRoot, filePath)))
    .filter(isBoundarySafetyCandidateFile);
}

async function collectChangedCandidateFiles() {
  const files = [];
  for (const file of collectChangedFileNames()) {
    if (!isBoundarySafetyCandidateFile(file)) {
      continue;
    }
    const absolutePath = path.join(repoRoot, file);
    if (existsSync(absolutePath)) {
      files.push(file);
    }
  }
  return files;
}

export async function collectBoundarySafetyInventory(options = {}) {
  const files =
    options.files ??
    (options.all ? await collectAllCandidateFiles() : await collectChangedCandidateFiles());
  const entries = [];
  for (const file of files) {
    const content = await fs.readFile(path.join(repoRoot, file), "utf8");
    for (const violation of findBoundarySafetyViolations(content, file)) {
      entries.push({
        file,
        line: violation.line,
        ruleId: violation.ruleId,
        match: violation.match,
        guidance: violation.guidance,
      });
    }
  }
  return sortInventory(entries);
}

function printViolationList(stream, title, entries) {
  if (entries.length === 0) {
    return;
  }
  stream.write(`${title}\n`);
  for (const entry of entries) {
    stream.write(`- ${entry.file}:${entry.line} ${entry.ruleId}: ${entry.match}\n`);
    stream.write(`  ${entry.guidance}\n`);
  }
}

function parseArgs(argv) {
  return {
    all: argv.includes("--all"),
    json: argv.includes("--json"),
    updateBaseline: argv.includes("--update-baseline"),
  };
}

export async function main(
  argv = process.argv.slice(2),
  io = { stdout: process.stdout, stderr: process.stderr },
) {
  const args = parseArgs(argv);
  const actual = await collectBoundarySafetyInventory({ all: args.all });

  if (args.json) {
    io.stdout.write(`${JSON.stringify(actual, null, 2)}\n`);
  }

  if (args.updateBaseline) {
    await fs.writeFile(baselinePath, `${JSON.stringify(actual, null, 2)}\n`);
    io.stdout.write(
      `Updated ${path.relative(repoRoot, baselinePath)} with ${actual.length} entries.\n`,
    );
    return 0;
  }

  const expected = await readBaseline();
  const diff = diffBoundaryInventory(expected, actual);

  if (args.all) {
    if (diff.unexpected.length === 0 && diff.missing.length === 0) {
      io.stdout.write(`Boundary safety baseline matches (${actual.length} entries).\n`);
      return 0;
    }
    io.stderr.write("Boundary safety baseline mismatch.\n");
    printViolationList(io.stderr, "Unexpected entries:", diff.unexpected);
    printViolationList(io.stderr, "Missing baseline entries:", diff.missing);
    io.stderr.write(
      "Run `node scripts/check-boundary-safety.mjs --all --update-baseline` only after intentional migrations.\n",
    );
    return 1;
  }

  if (diff.unexpected.length === 0) {
    io.stdout.write(
      `Boundary safety changed-file check passed (${actual.length} changed-file entries, all baseline-known).\n`,
    );
    return 0;
  }

  io.stderr.write("Found new boundary safety violations in changed production files.\n");
  printViolationList(io.stderr, "New entries:", diff.unexpected);
  io.stderr.write(
    "Use the canonical helper, or add a narrow `boundary-safety-ignore <rule-id>: <reason>` only for proven false positives.\n",
  );
  return 1;
}

runAsScript(import.meta.url, async () => {
  const code = await main();
  if (code !== 0) {
    process.exit(code);
  }
});
