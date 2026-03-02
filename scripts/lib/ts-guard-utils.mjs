import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const baseTestSuffixes = [".test.ts", ".test-utils.ts", ".test-harness.ts", ".e2e-harness.ts"];

export function resolveRepoRoot(importMetaUrl) {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), "..", "..");
}

export function isTestLikeTypeScriptFile(filePath, options = {}) {
  const extraTestSuffixes = options.extraTestSuffixes ?? [];
  return [...baseTestSuffixes, ...extraTestSuffixes].some((suffix) => filePath.endsWith(suffix));
}

export async function collectTypeScriptFiles(targetPath, options = {}) {
  const includeTests = options.includeTests ?? false;
  const extraTestSuffixes = options.extraTestSuffixes ?? [];
  const skipNodeModules = options.skipNodeModules ?? true;
  const ignoreMissing = options.ignoreMissing ?? false;

  let stat;
  try {
    stat = await fs.stat(targetPath);
  } catch (error) {
    if (
      ignoreMissing &&
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }

  if (stat.isFile()) {
    if (!targetPath.endsWith(".ts")) {
      return [];
    }
    if (!includeTests && isTestLikeTypeScriptFile(targetPath, { extraTestSuffixes })) {
      return [];
    }
    return [targetPath];
  }

  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const entryPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      if (skipNodeModules && entry.name === "node_modules") {
        continue;
      }
      out.push(...(await collectTypeScriptFiles(entryPath, options)));
      continue;
    }
    if (!entry.isFile() || !entryPath.endsWith(".ts")) {
      continue;
    }
    if (!includeTests && isTestLikeTypeScriptFile(entryPath, { extraTestSuffixes })) {
      continue;
    }
    out.push(entryPath);
  }
  return out;
}

export async function collectFileViolations(params) {
  const files = (
    await Promise.all(
      params.sourceRoots.map(
        async (root) =>
          await collectTypeScriptFiles(root, {
            ignoreMissing: true,
            extraTestSuffixes: params.extraTestSuffixes,
          }),
      ),
    )
  ).flat();

  const violations = [];
  for (const filePath of files) {
    if (params.skipFile?.(filePath)) {
      continue;
    }
    const content = await fs.readFile(filePath, "utf8");
    const fileViolations = params.findViolations(content, filePath);
    for (const violation of fileViolations) {
      violations.push({
        path: path.relative(params.repoRoot, filePath),
        ...violation,
      });
    }
  }
  return violations;
}

export function toLine(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

export function getPropertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

export function unwrapExpression(expression) {
  let current = expression;
  while (true) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

export function isDirectExecution(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return path.resolve(entry) === fileURLToPath(importMetaUrl);
}

export function runAsScript(importMetaUrl, main) {
  if (!isDirectExecution(importMetaUrl)) {
    return;
  }
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
