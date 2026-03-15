import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { runAsScript, toLine } from "./lib/ts-guard-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionsRoot = path.join(repoRoot, "extensions");
const baselinePath = path.join(repoRoot, "scripts", "plugin-import-boundaries.baseline.json");
const codeFileRe = /\.(?:[cm]?[jt]s|tsx|jsx)$/u;
const ignoredDirNames = new Set(["node_modules", "dist", "coverage", ".git"]);
const nodeBuiltinSpecifiers = new Set([
  "assert",
  "buffer",
  "child_process",
  "crypto",
  "events",
  "fs",
  "http",
  "https",
  "net",
  "os",
  "path",
  "stream",
  "timers",
  "tty",
  "url",
  "util",
  "zlib",
]);

type ViolationReason =
  | "relative_escape"
  | "absolute_import"
  | "core_internal_import"
  | "cross_extension_import";

export type PluginImportBoundaryViolation = {
  path: string;
  line: number;
  specifier: string;
  reason: ViolationReason;
};

function isCodeFile(filePath: string): boolean {
  return codeFileRe.test(filePath) && !filePath.endsWith(".d.ts");
}

async function collectExtensionCodeFiles(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (ignoredDirNames.has(entry.name)) {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && isCodeFile(fullPath)) {
        out.push(fullPath);
      }
    }
  }
  return out;
}

function getExtensionRoot(filePath: string): string | null {
  const relative = path.relative(extensionsRoot, filePath);
  if (relative.startsWith("..")) {
    return null;
  }
  const [extensionId] = relative.split(path.sep);
  return extensionId ? path.join(extensionsRoot, extensionId) : null;
}

function normalizeSpecifier(specifier: string): string {
  return specifier.replaceAll("\\", "/");
}

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || nodeBuiltinSpecifiers.has(specifier);
}

function isAllowedBareSpecifier(specifier: string): boolean {
  if (isNodeBuiltin(specifier)) {
    return true;
  }
  if (specifier === "openclaw/plugin-sdk" || specifier.startsWith("openclaw/plugin-sdk/")) {
    return true;
  }
  return (
    !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("openclaw/")
  );
}

function classifySpecifier(params: { importerPath: string; specifier: string }): {
  reason?: ViolationReason;
} {
  const specifier = normalizeSpecifier(params.specifier);
  if (specifier === "") {
    return {};
  }

  if (isAllowedBareSpecifier(specifier)) {
    return {};
  }

  if (specifier.startsWith("openclaw/src/") || specifier === "openclaw/src") {
    return { reason: "core_internal_import" };
  }

  if (specifier.startsWith("/")) {
    return { reason: "absolute_import" };
  }

  if (!specifier.startsWith(".")) {
    return { reason: "core_internal_import" };
  }

  const extensionRoot = getExtensionRoot(params.importerPath);
  if (!extensionRoot) {
    return {};
  }

  const importerDir = path.dirname(params.importerPath);
  const resolved = path.resolve(importerDir, specifier);
  const normalizedRoot = `${extensionRoot}${path.sep}`;
  const normalizedResolved = resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;
  if (!(resolved === extensionRoot || normalizedResolved.startsWith(normalizedRoot))) {
    const relativeToExtensions = path.relative(extensionsRoot, resolved);
    if (!relativeToExtensions.startsWith("..")) {
      return { reason: "cross_extension_import" };
    }
    return { reason: "relative_escape" };
  }

  return {};
}

function collectModuleSpecifiers(
  sourceFile: ts.SourceFile,
): Array<{ specifier: string; line: number }> {
  const specifiers: Array<{ specifier: string; line: number }> = [];

  const maybePushSpecifier = (node: ts.StringLiteralLike) => {
    specifiers.push({ specifier: node.text, line: toLine(sourceFile, node) });
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      maybePushSpecifier(node.moduleSpecifier);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      maybePushSpecifier(node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const firstArg = node.arguments[0];
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require") ||
        (ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.name) &&
          node.expression.name.text === "mock")
      ) {
        maybePushSpecifier(firstArg);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

export function findPluginImportBoundaryViolations(
  content: string,
  filePath: string,
): PluginImportBoundaryViolation[] {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const relativePath = path.relative(repoRoot, filePath);
  const violations: PluginImportBoundaryViolation[] = [];

  for (const entry of collectModuleSpecifiers(sourceFile)) {
    const classified = classifySpecifier({ importerPath: filePath, specifier: entry.specifier });
    if (!classified.reason) {
      continue;
    }
    violations.push({
      path: relativePath,
      line: entry.line,
      specifier: entry.specifier,
      reason: classified.reason,
    });
  }

  return violations;
}

async function loadBaseline(): Promise<PluginImportBoundaryViolation[]> {
  const raw = await fs.readFile(baselinePath, "utf8");
  return JSON.parse(raw) as PluginImportBoundaryViolation[];
}

function sortViolations(
  violations: PluginImportBoundaryViolation[],
): PluginImportBoundaryViolation[] {
  return [...violations].toSorted(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.specifier.localeCompare(right.specifier) ||
      left.reason.localeCompare(right.reason),
  );
}

async function collectViolations(): Promise<PluginImportBoundaryViolation[]> {
  const files = await collectExtensionCodeFiles(extensionsRoot);
  const violations: PluginImportBoundaryViolation[] = [];
  for (const filePath of files) {
    const content = await fs.readFile(filePath, "utf8");
    violations.push(...findPluginImportBoundaryViolations(content, filePath));
  }
  return sortViolations(violations);
}

function violationKey(violation: PluginImportBoundaryViolation): string {
  return `${violation.path}:${violation.line}:${violation.reason}:${violation.specifier}`;
}

async function writeBaseline(): Promise<void> {
  const violations = await collectViolations();
  await fs.writeFile(baselinePath, `${JSON.stringify(violations, null, 2)}\n`, "utf8");
  console.log(`Wrote plugin import boundary baseline (${violations.length} violations).`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--write-baseline")) {
    await writeBaseline();
    return;
  }

  const violations = await collectViolations();
  const baseline = sortViolations(await loadBaseline());
  const baselineKeys = new Set(baseline.map(violationKey));
  const violationKeys = new Set(violations.map(violationKey));

  const newViolations = violations.filter((entry) => !baselineKeys.has(violationKey(entry)));
  const resolvedViolations = baseline.filter((entry) => !violationKeys.has(violationKey(entry)));

  if (newViolations.length > 0) {
    console.error("New plugin import boundary violations found:");
    for (const violation of newViolations) {
      console.error(
        `- ${violation.path}:${violation.line} ${violation.reason} ${JSON.stringify(violation.specifier)}`,
      );
    }
    console.error(
      "Extensions may only import same-extension files, openclaw/plugin-sdk/*, Node builtins, or third-party packages.",
    );
    process.exit(1);
  }

  if (resolvedViolations.length > 0) {
    console.warn(
      `Note: ${resolvedViolations.length} baseline plugin-boundary violations were removed. Re-run with --write-baseline to refresh scripts/plugin-import-boundaries.baseline.json.`,
    );
  }

  console.log(
    `OK: no new plugin import boundary violations (${violations.length} baseline violations tracked).`,
  );
}

runAsScript(import.meta.url, main);
