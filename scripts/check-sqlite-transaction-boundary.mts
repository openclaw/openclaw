#!/usr/bin/env node

import path from "node:path";
import * as ts from "typescript/ast";
import { SymbolFlags, type Checker, type Type } from "typescript/sync";
import { createNativeTypeScriptProject } from "./lib/native-typescript.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import {
  collectFileViolations,
  resolveSourceRoots,
  runAsScript,
  toLine,
  unwrapExpression,
} from "./lib/ts-guard-utils.mts";

const removedAsyncTransactionNames = new Set([
  "runOpenClawAgentWriteTransactionAsync",
  "runSqliteImmediateTransactionAsync",
]);
const transactionBoundaries = new Map<string, { callback?: number; options?: number }>([
  ["runOpenClawAgentWriteTransaction", { callback: 0 }],
  ["runOpenClawAgentWriteWithYieldingAdmission", { callback: 0 }],
  ["runOpenClawStateWriteTransaction", { callback: 0 }],
  ["runPostgresTransactionSync", { callback: 1, options: 2 }],
  ["runSqliteReservedTransactionSync", { callback: 1, options: 2 }],
  ["runSqliteDeferredTransactionSync", { callback: 1, options: 2 }],
  ["runSqliteReadSnapshotSync", { callback: 1, options: 2 }],
  ["runSqliteImmediateTransactionSync", { callback: 1, options: 2 }],
  ["runSqliteSingleStatementSync", { callback: 1 }],
  ["runSqliteWorkerTransactionSync", { callback: 1, options: 2 }],
  // Preparation may await, but the physical commit hook must remain synchronous.
  ["runSqliteImmediateTransaction", { options: 2 }],
  ["withSessionActorTransactionState", { callback: 2 }],
  ["withSqliteDatabaseWriteScope", { callback: 2 }],
]);

function expressionName(expression: ts.Expression) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    return unwrapped.text;
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    return unwrapped.name.text;
  }
  if (ts.isElementAccessExpression(unwrapped) && ts.isStringLiteral(unwrapped.argumentExpression)) {
    return unwrapped.argumentExpression.text;
  }
  return undefined;
}

function hasAsyncModifier(node: ts.FunctionLikeDeclaration) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true;
}

function collectSynchronousTransactionAliases(sourceFile: ts.SourceFile) {
  const aliases = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) {
      continue;
    }
    for (const specifier of bindings.elements) {
      const importedName = specifier.propertyName?.text ?? specifier.name.text;
      if (transactionBoundaries.has(importedName)) {
        aliases.set(specifier.name.text, importedName);
      }
    }
  }
  return aliases;
}

function mayReturnThenable(type: Type, checker: Checker): boolean {
  const hasThen = (result: Type): boolean =>
    result.isUnionType()
      ? result.getTypes().some(hasThen)
      : Boolean(checker.getTypeOfPropertyOfType(result, "then")?.getCallSignatures().length);
  const signatures = type.getNonNullableType().getCallSignatures();
  // An overload set may expose a synchronous invocation. Do not condemn it from
  // an unrelated async overload; unresolved/erased types are not proof either.
  return (
    signatures.length > 0 && signatures.every((s) => hasThen(checker.getReturnTypeOfSignature(s)))
  );
}

function valueDeclaration(expression: ts.Expression, checker: Checker) {
  const node = unwrapExpression(expression);
  // A shorthand's name denotes the property; its value symbol owns the callback.
  let symbol = ts.isShorthandPropertyAssignment(node.parent)
    ? checker.getShorthandAssignmentValueSymbol(node.parent)
    : checker.getSymbolAtLocation(node);
  if (symbol && symbol.flags & SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol?.valueDeclaration?.resolve();
}

function isAsyncCallback(
  expression: ts.Expression,
  checker: Checker,
  seen = new Set<ts.Node>(),
): boolean {
  const node = unwrapExpression(expression);
  if (seen.has(node)) {
    return false;
  }
  seen.add(node);
  if (
    ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && hasAsyncModifier(node)) ||
    mayReturnThenable(checker.getTypeAtLocation(node), checker)
  ) {
    return true;
  }
  // A void callback annotation can erase the Promise result. Follow the actual
  // declaration, including imports, without confusing a shadowed local name.
  const declaration = valueDeclaration(node, checker);
  return declaration && ts.isFunctionDeclaration(declaration)
    ? hasAsyncModifier(declaration)
    : Boolean(
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        ts.isVariableDeclarationList(declaration.parent) &&
        declaration.parent.flags & ts.NodeFlags.Const &&
        declaration.initializer &&
        isAsyncCallback(declaration.initializer, checker, seen),
      );
}

function hasAsyncCommitHook(expression: ts.Expression, checker: Checker): boolean {
  const node = unwrapExpression(expression);
  const hook = checker.getTypeOfPropertyOfType(checker.getTypeAtLocation(node), "withCommit");
  if (hook && mayReturnThenable(hook, checker)) {
    return true;
  }
  if (ts.isObjectLiteralExpression(node)) {
    // Last assignment wins. Optional spreads may leave an earlier hook intact.
    for (const property of node.properties.toReversed()) {
      if (ts.isSpreadAssignment(property)) {
        if (hasAsyncCommitHook(property.expression, checker)) {
          return true;
        }
        const spreadHook = checker.getTypeAtLocation(property.expression).getProperty("withCommit");
        if (spreadHook && !(spreadHook.flags & SymbolFlags.Optional)) {
          return false;
        }
      } else {
        const name = property.name;
        const computed = ts.isComputedPropertyName(name)
          ? checker.getTypeAtLocation(name.expression)
          : undefined;
        const key = computed
          ? computed.isStringLiteralType()
            ? computed.value
            : undefined
          : ts.isIdentifier(name) || ts.isStringLiteral(name)
            ? name.text
            : undefined;
        if (key === "withCommit") {
          return ts.isMethodDeclaration(property)
            ? hasAsyncModifier(property) ||
                mayReturnThenable(checker.getTypeAtLocation(property), checker)
            : ts.isPropertyAssignment(property)
              ? isAsyncCallback(property.initializer, checker)
              : ts.isShorthandPropertyAssignment(property) &&
                ts.isIdentifier(property.name) &&
                isAsyncCallback(property.name, checker);
        }
      }
    }
    return false;
  }
  // Options properties remain mutable even on const bindings. An erased hook
  // type cannot be recovered safely from the object's original initializer.
  return false;
}

function isPostgresTransaction(node: ts.CallExpression, checker: Checker) {
  const declaration = checker.getResolvedSignature(node).declaration?.resolve();
  const owner = declaration?.getSourceFile().fileName.replaceAll("\\", "/");
  return (
    owner?.endsWith("/src/infra/sql-connection.ts") ||
    owner?.endsWith("/src/infra/postgres-sync/connection.ts")
  );
}

export function findSqliteTransactionBoundaryViolations(
  sourceFile: ts.SourceFile,
  checker: Checker,
) {
  const transactionAliases = collectSynchronousTransactionAliases(sourceFile);
  const violations: Array<{ line: number; reason: string }> = [];

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          const importedName = specifier.propertyName?.text ?? specifier.name.text;
          if (removedAsyncTransactionNames.has(importedName)) {
            violations.push({
              line: toLine(sourceFile, specifier),
              reason: `imports removed async SQLite transaction primitive "${importedName}"`,
            });
          }
        }
      }
    }

    const declaredName =
      ts.isFunctionDeclaration(node) && node.name
        ? node.name
        : ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
          ? node.name
          : undefined;
    if (declaredName && removedAsyncTransactionNames.has(declaredName.text)) {
      violations.push({
        line: toLine(sourceFile, declaredName),
        reason: `declares removed async SQLite transaction primitive "${declaredName.text}"`,
      });
    }

    if (ts.isCallExpression(node)) {
      const calledName = expressionName(node.expression);
      if (calledName && removedAsyncTransactionNames.has(calledName)) {
        violations.push({
          line: toLine(sourceFile, node.expression),
          reason: `calls removed async SQLite transaction primitive "${calledName}"`,
        });
      }
      const canonicalName = calledName
        ? (transactionAliases.get(calledName) ?? calledName)
        : undefined;
      const boundary =
        canonicalName === "runTransaction" && isPostgresTransaction(node, checker)
          ? { callback: 0, options: 1 }
          : canonicalName
            ? transactionBoundaries.get(canonicalName)
            : undefined;
      const callbackIndex = boundary?.callback;
      const callback = callbackIndex === undefined ? undefined : node.arguments[callbackIndex];
      if (canonicalName && callback && isAsyncCallback(callback, checker)) {
        violations.push({
          line: toLine(sourceFile, callback),
          reason: `passes an async callback to synchronous SQLite transaction helper "${canonicalName}"`,
        });
      }
      const options =
        boundary?.options === undefined ? undefined : node.arguments[boundary.options];
      if (options && hasAsyncCommitHook(options, checker)) {
        violations.push({
          line: toLine(sourceFile, options),
          reason: "passes an async commit hook to synchronous SQLite transaction helper",
        });
      }
    }

    node.forEachChild(visit);
  };
  visit(sourceFile);
  return violations;
}

async function main() {
  const repoRoot = resolveRepoRoot(import.meta.url);
  const names = [
    ...transactionBoundaries.keys(),
    ...removedAsyncTransactionNames,
    "runTransaction",
  ];
  const candidates = await collectFileViolations({
    repoRoot,
    sourceRoots: resolveSourceRoots(repoRoot, ["src", "extensions", "packages"]),
    skipFile: (filePath) => /(^|[\\/])dist([\\/]|$)/.test(filePath),
    findViolations: (content, file) =>
      names.some((name) => content.includes(name)) ? [{ file }] : [],
  });
  const violations: Array<{ path: string; line: number; reason: string }> = [];
  if (candidates.length) {
    // One semantic snapshot resolves imported results and spread properties. Only
    // candidate files are roots; unrelated repository diagnostics are not a gate.
    const configFileName = path.join(repoRoot, "tsconfig.transaction-boundary.json");
    using session = createNativeTypeScriptProject({
      cwd: repoRoot,
      configFileName,
      files: {
        [configFileName]: JSON.stringify({
          extends: "./tsconfig.json",
          files: candidates.map(({ file }) => file),
          include: [],
        }),
      },
    });
    for (const candidate of candidates) {
      const source = session.project.program.getSourceFile(candidate.file);
      if (!source) {
        throw new Error(`Native TypeScript did not load ${candidate.path}`);
      }
      for (const violation of findSqliteTransactionBoundaryViolations(
        source,
        session.project.checker,
      )) {
        violations.push({ path: candidate.path, ...violation });
      }
    }
  }
  if (violations.length === 0) {
    console.log("SQLite transaction boundary guard passed.");
    return;
  }
  console.error("Found asynchronous SQLite transaction work:");
  for (const violation of violations) {
    console.error(`- ${violation.path}:${violation.line}: ${violation.reason}`);
  }
  console.error(
    "Complete asynchronous preparation before the transaction, then validate and apply inside a synchronous transaction callback.",
  );
  process.exitCode = 1;
}

runAsScript(import.meta.url, main);
