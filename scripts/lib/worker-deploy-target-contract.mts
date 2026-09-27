import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import * as ts from "typescript/unstable/ast";
import { createFrozenTargetSource } from "./frozen-target-source.mjs";
import { createNativeTypeScriptParser } from "./native-typescript.mts";
import { resolveReleaseTagPackageIdentity } from "./release-version.mjs";

const ARTIFACT_NAME = /^WORKER_BUNDLE_[A-Z0-9_]+_PATH$/u;
const ARTIFACT_ARRAY = "WORKER_BUNDLE_ARTIFACT_PATHS";
const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_ARTIFACTS = 16;
const PRODUCER_PATH = "src/worker/worker-deploy-entry.ts";
const DECLARATIONS_PATH = "src/shared/worker-bundle-hash.ts";

export function readPublishedWorkerDeployTargetPaths(params: {
  targetRoot: string;
  targetSha: string;
  version: string;
}): string[] {
  const target = createFrozenTargetSource(params.targetRoot, params.targetSha);
  target.assertCleanCheckout(["package.json", PRODUCER_PATH, DECLARATIONS_PATH]);
  const manifestText = target.readText("package.json");
  const manifest: unknown = manifestText === null ? null : JSON.parse(manifestText);
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("name" in manifest) ||
    manifest.name !== "openclaw" ||
    !("version" in manifest) ||
    typeof manifest.version !== "string"
  ) {
    throw new Error("Selected source must contain an openclaw package.json with a version.");
  }
  const identity = resolveReleaseTagPackageIdentity(`v${params.version}`, manifest.version);
  if (identity.baseTag) {
    target.assertTagResolvesToSelectedSource(identity.baseTag);
  }
  // Applicability is a committed source fact, only after release identity admission.
  if (!target.hasPath(PRODUCER_PATH)) {
    return [];
  }
  const text = target.readText(DECLARATIONS_PATH);
  if (text === null || Buffer.byteLength(text, "utf8") > MAX_SOURCE_BYTES) {
    throw new Error(
      "Target worker artifact declarations must be a regular file of at most 64 KiB.",
    );
  }
  return parseWorkerDeployTargetPaths(join(params.targetRoot, DECLARATIONS_PATH), text);
}

/** Read the frozen target's declarations without importing its executable module. */
export function readWorkerDeployTargetPaths(targetRoot: string): string[] {
  // Shared hash helpers alone do not impose a deploy contract on historical targets.
  if (!existsSync(join(targetRoot, PRODUCER_PATH))) {
    return [];
  }
  const sourcePath = join(targetRoot, DECLARATIONS_PATH);
  const stat = lstatSync(sourcePath);
  if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) {
    throw new Error(
      "Target worker artifact declarations must be a regular file of at most 64 KiB.",
    );
  }
  const text = readFileSync(sourcePath, "utf8");
  return parseWorkerDeployTargetPaths(sourcePath, text);
}

function parseWorkerDeployTargetPaths(sourcePath: string, text: string): string[] {
  using parser = createNativeTypeScriptParser();
  const source = parser.parseSourceFile(sourcePath, text);
  if (parser.getSyntacticDiagnostics(sourcePath).length > 0) {
    throw new Error("Target worker artifact declarations contain invalid TypeScript.");
  }
  const declarations = new Map<string, { initializer?: ts.Expression; constant: boolean }>();
  const exports = new Map<string, string>();
  function addExport(name: string, localName: string) {
    if (exports.has(name)) {
      throw new Error(`Duplicate target worker export: ${name}.`);
    }
    exports.set(name, localName);
  }
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      if (
        statement.moduleSpecifier ||
        !statement.exportClause ||
        !ts.isNamedExports(statement.exportClause)
      ) {
        throw new Error("Target worker artifact exports must be declared locally.");
      }
      for (const element of statement.exportClause.elements) {
        if (!element.isTypeOnly) {
          addExport(element.name.text, (element.propertyName ?? element.name).text);
        }
      }
    }
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    const exported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) {
        if (exported) {
          throw new Error("Target worker artifact exports must use named constant declarations.");
        }
        continue;
      }
      const name = declaration.name.text;
      if (declarations.has(name)) {
        throw new Error(`Duplicate target worker declaration: ${name}.`);
      }
      declarations.set(name, {
        initializer: declaration.initializer,
        constant: (statement.declarationList.flags & ts.NodeFlags.Const) !== 0,
      });
      if (exported) {
        addExport(name, name);
      }
    }
  }
  function resolveLiteral(expression: ts.Expression | undefined, depth = 0): ts.Expression {
    if (!expression || depth > MAX_ARTIFACTS) {
      throw new Error(
        "Target worker artifact declaration has a missing, cyclic, or unbounded constant reference.",
      );
    }
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertion(expression) ||
      ts.isSatisfiesExpression(expression)
    ) {
      return resolveLiteral(expression.expression, depth + 1);
    }
    if (ts.isIdentifier(expression)) {
      const declaration = declarations.get(expression.text);
      if (!declaration?.constant) {
        throw new Error(
          `Target worker artifact reference must be a local constant: ${expression.text}.`,
        );
      }
      return resolveLiteral(declaration.initializer, depth + 1);
    }
    return expression;
  }
  function readConstant(name: string): ts.Expression {
    const declaration = declarations.get(name);
    if (!declaration?.constant) {
      throw new Error(`Target worker artifact declaration must be constant: ${name}.`);
    }
    return resolveLiteral(declaration.initializer);
  }

  let artifacts: Array<[string, ts.Expression]>;
  const arrayName = exports.get(ARTIFACT_ARRAY);
  if (arrayName !== undefined) {
    const array = readConstant(arrayName);
    if (!ts.isArrayLiteralExpression(array) || array.elements.length === 0) {
      throw new Error("Target WORKER_BUNDLE_ARTIFACT_PATHS must be a non-empty array.");
    }
    if (array.elements.length > MAX_ARTIFACTS) {
      throw new Error("Target worker artifact count must be between 1 and 16.");
    }
    artifacts = array.elements.map((element, index) => [
      `${ARTIFACT_ARRAY}[${index}]`,
      resolveLiteral(element),
    ]);
  } else {
    // v2026.9.4 frozen targets predate the canonical array. Keep the fallback until
    // every supported frozen release target declares that array.
    artifacts = [...exports]
      .filter(([name]) => ARTIFACT_NAME.test(name))
      .map(([name, localName]) => [name, readConstant(localName)]);
  }
  if (artifacts.length === 0 || artifacts.length > MAX_ARTIFACTS) {
    throw new Error("Target worker artifact count must be between 1 and 16.");
  }
  const paths = artifacts.map(([name, expression]) => {
    if (!ts.isStringLiteral(expression) || !expression.text.trim()) {
      throw new Error(`Target worker artifact ${name} must be a non-empty path string.`);
    }
    const value = expression.text;
    const normalized = posix.normalize(value);
    if (
      value !== normalized ||
      value.length > 1024 ||
      !/^[A-Za-z0-9._/-]+$/u.test(value) ||
      normalized.split("/").some((part) => part === ".." || part === "." || part === "") ||
      win32.isAbsolute(value)
    ) {
      throw new Error(
        `Target worker artifact ${name} must be a normalized relative path within dist/worker.`,
      );
    }
    return `dist/worker/${value}`;
  });
  if (new Set(paths).size !== paths.length) {
    throw new Error("Target worker artifact paths must be unique.");
  }
  return paths.toSorted();
}
