#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// Enforces release-train metadata on core gateway methods.
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import * as ts from "typescript/ast";
import { createNativeTypeScriptParser } from "./lib/native-typescript.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { getPropertyNameText } from "./lib/ts-guard-utils.mts";

const repoRoot = resolveRepoRoot(import.meta.url);
const descriptorPath = "src/gateway/methods/core-descriptors.ts";
const suffixPath = "src/gateway/methods/core-descriptor-additions.ts";
const suffixExport = "CORE_GATEWAY_METHOD_ADDITIONS";
const suffixImport = "./core-descriptor-additions.js";

type MethodSpec = {
  fileName: string;
  line: number;
  name: string;
  since: string | undefined;
  compatibilityRestored: boolean;
};

function runGit(args: string[]): string {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `git exited ${result.status}`;
    throw new Error(
      `${detail}\nRun git fetch origin main so origin/main and its merge-base are available.`,
    );
  }
  return result.stdout.trim();
}

function tryRunGit(args: string[]): string | undefined {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function resolveBaseCommit(): string {
  const explicitBase = process.env.PROTOCOL_SINCE_BASE_SHA?.trim();
  if (explicitBase) {
    if (!/^[0-9a-f]{40}$/u.test(explicitBase)) {
      throw new Error("PROTOCOL_SINCE_BASE_SHA must be a full commit SHA.");
    }
    if (tryRunGit(["cat-file", "-e", `${explicitBase}:${descriptorPath}`]) === undefined) {
      throw new Error(`PROTOCOL_SINCE_BASE_SHA ${explicitBase} is unavailable in this checkout.`);
    }
    return explicitBase;
  }
  const mainMergeBase = tryRunGit(["merge-base", "HEAD", "origin/main"]);
  if (mainMergeBase) {
    return mainMergeBase;
  }
  // Pull-request CI checks out a synthetic merge commit without creating origin/main.
  // Its first parent is the exact base used to build the merge result.
  const parents = (tryRunGit(["show", "-s", "--format=%P", "HEAD"]) ?? "").split(/\s+/u);
  if (parents.length === 2 && parents[0]) {
    return parents[0];
  }
  throw new Error(
    "Could not resolve PROTOCOL_SINCE_BASE_SHA, origin/main, or a two-parent pull-request merge checkout.",
  );
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function stringProperty(object: ts.ObjectLiteralExpression, key: string): string | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const name = getPropertyNameText(property.name);
    if (name === key && ts.isStringLiteralLikeNode(property.initializer)) {
      return property.initializer.text;
    }
  }
  return undefined;
}

function trueProperty(object: ts.ObjectLiteralExpression, key: string): boolean {
  return object.properties.some((property) => {
    if (!ts.isPropertyAssignment(property)) {
      return false;
    }
    const name = getPropertyNameText(property.name);
    return name === key && property.initializer.kind === ts.SyntaxKind.TrueKeyword;
  });
}

function collectMethodSpec(
  element: ts.Expression,
  sourceFile: ts.SourceFile,
  fileName: string,
): MethodSpec {
  const line = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile)).line + 1;
  if (ts.isObjectLiteralExpression(element)) {
    const name = stringProperty(element, "name");
    if (!name) {
      throw new Error(
        `${fileName}:${line} core method spec names must be string literals so additions can be compared with origin/main.`,
      );
    }
    return {
      name,
      since: stringProperty(element, "since"),
      compatibilityRestored: trueProperty(element, "compatibilityRestored"),
      line,
      fileName,
    };
  }
  if (ts.isArrayLiteralExpression(element)) {
    const name = element.elements[0];
    const since = element.elements[3];
    if (
      element.elements.some(ts.isSpreadElement) ||
      !name ||
      !since ||
      !ts.isStringLiteralLikeNode(name) ||
      !ts.isStringLiteralLikeNode(since)
    ) {
      throw new Error(
        `${fileName}:${line} core method spec rows must use string literal names and vintage metadata.`,
      );
    }
    const policy = element.elements[4];
    const compatibilityRestored =
      policy !== undefined && ts.isObjectLiteralExpression(policy)
        ? trueProperty(policy, "compatibilityRestored")
        : false;
    return { name: name.text, since: since.text, compatibilityRestored, line, fileName };
  }
  throw new Error(
    `${fileName}:${line} core method specs must be inline object literals or labeled rows so vintage metadata can be enforced.`,
  );
}

function methodArray(
  sourceFile: ts.SourceFile,
  name: string,
  fileName: string,
): ts.ArrayLiteralExpression {
  const declarations = sourceFile.statements.flatMap((statement) =>
    ts.isVariableStatement(statement) &&
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
    (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
      ? [...statement.declarationList.declarations].filter(
          (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
        )
      : [],
  );
  const declaration = declarations[0];
  const initializer = declaration?.initializer && unwrapExpression(declaration.initializer);
  if (declarations.length !== 1 || !initializer || !ts.isArrayLiteralExpression(initializer)) {
    throw new Error(
      "Could not find one exported const literal array " + name + " in " + fileName + ".",
    );
  }
  return initializer;
}

function isSupportedSuffixImport(sourceFile: ts.SourceFile, localName: string): boolean {
  const imports = sourceFile.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement)) {
      return [];
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) {
      return [];
    }
    return bindings.elements
      .filter((binding) => binding.name.text === localName)
      .map((binding) => ({ statement, binding }));
  });
  const entry = imports[0];
  const shadowed = sourceFile.statements.some(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === localName,
      ),
  );
  if (imports.length !== 1 || !entry || shadowed) {
    return false;
  }
  return (
    entry.statement.importClause?.phaseModifier === undefined &&
    !entry.binding.isTypeOnly &&
    ts.isStringLiteralLikeNode(entry.statement.moduleSpecifier) &&
    entry.statement.moduleSpecifier.text === suffixImport &&
    (entry.binding.propertyName?.text ?? entry.binding.name.text) === suffixExport
  );
}

function collectMethodSpecs(
  sourceFile: ts.SourceFile,
  fileName: string,
  readSuffix: () => { sourceFile: ts.SourceFile; fileName: string },
): MethodSpec[] {
  const array = methodArray(sourceFile, "CORE_GATEWAY_METHOD_SPECS", fileName);
  const specs: MethodSpec[] = [];
  for (const [index, element] of array.elements.entries()) {
    if (!ts.isSpreadElement(element)) {
      specs.push(collectMethodSpec(element, sourceFile, fileName));
      continue;
    }
    const line = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile)).line + 1;
    if (
      index !== array.elements.length - 1 ||
      !ts.isIdentifier(element.expression) ||
      !isSupportedSuffixImport(sourceFile, element.expression.text)
    ) {
      throw new Error(
        fileName +
          ":" +
          line +
          " method suffix must be the final spread of a named static import of " +
          suffixExport +
          " from " +
          suffixImport +
          ".",
      );
    }
    // Follow this one canonical source owner, never arbitrary imports or evaluated expressions.
    const suffix = readSuffix();
    specs.push(
      ...methodArray(suffix.sourceFile, suffixExport, suffix.fileName).elements.map((row) =>
        collectMethodSpec(row, suffix.sourceFile, suffix.fileName),
      ),
    );
  }
  const names = new Set<string>();
  for (const spec of specs) {
    if (names.has(spec.name)) {
      throw new Error(
        spec.fileName + ":" + spec.line + " duplicate core method identity " + spec.name + ".",
      );
    }
    names.add(spec.name);
  }
  return specs;
}

function validVintage(value: string): boolean {
  return /^(?:<=)?[0-9]{4}[.](?:[1-9]|1[0-2])$/u.test(value);
}

function validateCurrentSpecs(current: MethodSpec[], base: MethodSpec[]): void {
  for (const spec of current) {
    if (!spec.since) {
      throw new Error(
        spec.fileName + ":" + spec.line + " " + spec.name + " is missing since metadata.",
      );
    }
    if (!validVintage(spec.since)) {
      throw new Error(
        spec.fileName +
          ":" +
          spec.line +
          " " +
          spec.name +
          " has invalid vintage " +
          JSON.stringify(spec.since) +
          ".",
      );
    }
  }
  for (const [index, previous] of base.entries()) {
    if (current[index]?.name !== previous.name) {
      throw new Error(
        "Core method table is append-only; preserve existing method order at index " +
          index +
          " (" +
          previous.name +
          ").",
      );
    }
  }
}

function currentTrain(): string {
  const packageJson: unknown = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  if (!isRecord(packageJson)) {
    throw new Error("Root package.json must contain an object.");
  }
  const version = typeof packageJson.version === "string" ? packageJson.version : "";
  const match = /^(\d{4})\.(\d{1,2})(?:\.|$)/.exec(version);
  if (!match) {
    throw new Error(`Root package version ${JSON.stringify(packageJson.version)} is not calver.`);
  }
  const train = match[1]! + "." + match[2]!;
  if (!validVintage(train)) {
    throw new Error("Root package version is not valid calver: " + version);
  }
  return train;
}

try {
  using parser = createNativeTypeScriptParser({ cwd: repoRoot });
  const train = currentTrain();
  const mergeBase = resolveBaseCommit();
  const currentSource = fs.readFileSync(path.join(repoRoot, descriptorPath), "utf8");
  const currentSpecs = collectMethodSpecs(
    parser.parseSourceFile(descriptorPath, currentSource),
    descriptorPath,
    () => ({
      sourceFile: parser.parseSourceFile(
        suffixPath,
        fs.readFileSync(path.join(repoRoot, suffixPath), "utf8"),
      ),
      fileName: suffixPath,
    }),
  );
  const baseSource = runGit(["show", mergeBase + ":" + descriptorPath]);
  const baseSpecs = collectMethodSpecs(
    parser.parseSourceFile(descriptorPath, baseSource),
    descriptorPath + "@" + mergeBase,
    () => ({
      sourceFile: parser.parseSourceFile(
        suffixPath,
        runGit(["show", mergeBase + ":" + suffixPath]),
      ),
      fileName: suffixPath + "@" + mergeBase,
    }),
  );
  validateCurrentSpecs(currentSpecs, baseSpecs);
  const baseNames = new Set(baseSpecs.map((spec) => spec.name));
  const added = currentSpecs.filter((spec) => !baseNames.has(spec.name));
  const restored = added.filter((spec) => spec.compatibilityRestored);
  const newMethods = added.filter((spec) => !spec.compatibilityRestored);
  // Restored shipped methods retain their historical vintage so discovery and
  // generated clients see the original availability contract, not a new API.
  const violations = added.filter((spec) =>
    spec.compatibilityRestored ? !spec.since?.startsWith("<=") : spec.since !== train,
  );

  if (violations.length > 0) {
    console.error(`Protocol since guard failed for current train ${train}:`);
    for (const spec of violations) {
      const problem = spec.compatibilityRestored
        ? `is marked compatibilityRestored but has non-historical since ${JSON.stringify(spec.since)}`
        : spec.since
          ? `has since ${JSON.stringify(spec.since)}`
          : "is missing since metadata";
      console.error(
        spec.compatibilityRestored
          ? `- ${spec.fileName}:${spec.line} ${spec.name} ${problem}; restored compatibility methods must retain <= vintage metadata.`
          : `- ${spec.fileName}:${spec.line} ${spec.name} ${problem}; add since: ${JSON.stringify(train)}.`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log(
      `protocol since guard passed: ${newMethods.length} new core method${newMethods.length === 1 ? "" : "s"} use train ${train}; ${restored.length} restored compatibility method${restored.length === 1 ? "" : "s"} retain historical vintage`,
    );
  }
} catch (error) {
  console.error(
    `Protocol since guard failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
