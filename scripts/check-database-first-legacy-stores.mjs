#!/usr/bin/env node

// Guards database-first state ownership by blocking legacy store writes in runtime code.
import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  collectTypeScriptFilesFromRoots,
  resolveRepoRoot,
  runAsScript,
  toLine,
  unwrapExpression,
} from "./lib/ts-guard-utils.mjs";

export const databaseFirstLegacyStoreSourceRoots = ["src", "extensions", "packages"];

const legacyWriteCallees = new Set([
  "appendFile",
  "appendFileSync",
  "copyFile",
  "copyFileSync",
  "createWriteStream",
  "open",
  "openSync",
  "rename",
  "renameSync",
  "writeFile",
  "writeFileSync",
]);

const helperWriteCallees = new Set([
  "appendRegularFile",
  "appendRegularFileSync",
  "replaceFileAtomic",
  "replaceFileAtomicSync",
  "writeJson",
  "writeJsonAtomic",
  "writeJsonFileAtomically",
  "writeJsonSync",
  "writeTextAtomic",
]);

const bridgeMarkerPattern = /\btranscriptLocator\b|sqlite-transcript:\/\//u;

const legacyStorePatterns = [
  /\bsessions\.json\b/u,
  /\.trajectory\.jsonl\b/u,
  /\.acp-stream\.jsonl\b/u,
  /\bacp\/event-ledger\.json\b/u,
  /\bcache\/[^"'`]*\.json\b/u,
  /\bagents\/[^"'`]+\/agent\/(?:auth|models)\.json\b/u,
  /\b(?:credentials\/oauth|github-copilot\.token|openrouter-models|auth-profiles|auth-state|exec-approvals|workspace-state)\.json\b/u,
  /\bcron\/(?:runs\/[^"'`]+\.jsonl|jobs\.json|jobs-state\.json)\b/u,
  /\b(?:process-leases|session-toggles|known-users|msteams-conversations|msteams-polls|msteams-sso-tokens|bot-storage|sync-store|thread-bindings|inbound-dedupe|startup-verification|storage-meta|crypto-idb-snapshot|command-deploy-cache|plugin-binding-approvals|plugins\/installs|config-health|port-guard|restart-sentinel|gateway-restart-intent|gateway-supervisor-restart-handoff)\.json\b/u,
  /\b(?:calls|ref-index|audit\/file-transfer|audit\/crestodian)\.jsonl\b/u,
  /\b(?:reply-cache|sent-echoes|events|claims)\.jsonl\b/u,
  /\bplugin-state\/state\.sqlite\b/u,
  /\btasks\/(?:runs\.sqlite|flows\/registry\.sqlite)\b/u,
  /\bopenclaw-state\.sqlite\b/u,
];

const allowedRuntimeMigrationPaths = [
  "src/commands/doctor/",
  "src/infra/session-state-migration.ts",
  "src/infra/state-migrations.ts",
  "src/commands/session-state-migration.ts",
  "src/commands/doctor-state-migrations.test.ts",
];

const allowedFixturePaths = new Set([
  "extensions/qa-lab/src/providers/shared/auth-store.ts",
  "extensions/qa-matrix/src/runners/contract/scenario-runtime-e2ee-destructive.ts",
]);

const allowedCurrentLegacyWritePaths = new Set([
  "extensions/codex/src/app-server/trajectory.ts",
  "extensions/file-transfer/src/shared/audit.ts",
  "src/crestodian/audit.ts",
  "src/memory-host-sdk/events.ts",
  "src/infra/restart-sentinel.ts",
  "src/infra/restart.ts",
]);

function isAllowedLegacyOwnerPath(relativePath) {
  return (
    allowedFixturePaths.has(relativePath) ||
    allowedCurrentLegacyWritePaths.has(relativePath) ||
    allowedRuntimeMigrationPaths.some((allowed) => relativePath.startsWith(allowed)) ||
    /^extensions\/[^/]+\/(?:doctor-contract-api|legacy-state-migrations-api)\.ts$/u.test(
      relativePath,
    ) ||
    /^extensions\/[^/]+\/.*migrations?(?:[./-][^/]*)?\.ts$/u.test(relativePath)
  );
}

function nodeTextContainsLegacyStore(sourceFile, node) {
  return legacyCandidateTexts(sourceFile, node).some((text) =>
    legacyStorePatterns.some((pattern) => pattern.test(text)),
  );
}

function importSource(node) {
  const moduleSpecifier = node.moduleSpecifier;
  return ts.isStringLiteral(moduleSpecifier) ? moduleSpecifier.text : "";
}

function collectFsBindings(sourceFile) {
  const fsModuleSpecifiers = new Set(["node:fs", "node:fs/promises", "fs", "fs/promises"]);
  const fsModuleBindings = new Set();
  const fsWriteAliases = new Map();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const source = importSource(statement);
    const clause = statement.importClause;
    if (!clause) {
      continue;
    }
    if (clause.name && fsModuleSpecifiers.has(source)) {
      fsModuleBindings.add(clause.name.text);
    }
    const namedBindings = clause.namedBindings;
    if (!namedBindings) {
      continue;
    }
    if (ts.isNamespaceImport(namedBindings)) {
      if (fsModuleSpecifiers.has(source)) {
        fsModuleBindings.add(namedBindings.name.text);
      }
      continue;
    }
    for (const element of namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (fsModuleSpecifiers.has(source) && importedName === "promises") {
        fsModuleBindings.add(element.name.text);
      }
      if (fsModuleSpecifiers.has(source) && legacyWriteCallees.has(importedName)) {
        fsWriteAliases.set(element.name.text, importedName);
      }
      if (helperWriteCallees.has(importedName)) {
        fsWriteAliases.set(element.name.text, importedName);
      }
    }
  }

  return { fsModuleBindings, fsWriteAliases };
}

function legacyCandidateTexts(sourceFile, node) {
  const candidates = [node.getText(sourceFile)];
  const stringSegments = [];
  function visit(current) {
    if (ts.isStringLiteralLike(current)) {
      stringSegments.push(current.text);
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  if (stringSegments.length > 1) {
    candidates.push(stringSegments.join("/"));
  }
  return candidates;
}

/**
 * Finds database-first legacy-store violations in one TypeScript/JavaScript source file.
 */
export function collectDatabaseFirstLegacyStoreViolations(content, relativePath = "source.ts") {
  if (isAllowedLegacyOwnerPath(relativePath)) {
    return [];
  }

  const sourceFile = ts.createSourceFile(relativePath, content, ts.ScriptTarget.Latest, true);
  const { fsModuleBindings, fsWriteAliases } = collectFsBindings(sourceFile);
  const violations = [];
  const seenViolations = new Set();
  const legacyPathScopes = [new Map()];

  function addViolation(node, kind) {
    const line = toLine(sourceFile, node);
    const key = `${line}:${kind}`;
    if (seenViolations.has(key)) {
      return;
    }
    seenViolations.add(key);
    violations.push({ kind, line });
  }

  function currentLegacyPathScope() {
    return legacyPathScopes[legacyPathScopes.length - 1];
  }

  function resolveLegacyPathIdentifier(name) {
    for (let index = legacyPathScopes.length - 1; index >= 0; index--) {
      const scope = legacyPathScopes[index];
      if (scope.has(name)) {
        return scope.get(name) === true;
      }
    }
    return false;
  }

  function expressionContainsLegacyStore(node) {
    if (nodeTextContainsLegacyStore(sourceFile, node)) {
      return true;
    }
    let found = false;
    function visitExpression(current) {
      if (found) {
        return;
      }
      if (ts.isIdentifier(current) && resolveLegacyPathIdentifier(current.text)) {
        found = true;
        return;
      }
      ts.forEachChild(current, visitExpression);
    }
    visitExpression(node);
    return found;
  }

  function visitWithChildScope(node) {
    legacyPathScopes.push(new Map());
    ts.forEachChild(node, visit);
    legacyPathScopes.pop();
  }

  function visitFunctionLike(node) {
    legacyPathScopes.push(new Map());
    for (const parameter of node.parameters) {
      if (ts.isIdentifier(parameter.name)) {
        currentLegacyPathScope().set(parameter.name.text, false);
      }
    }
    ts.forEachChild(node, visit);
    legacyPathScopes.pop();
  }

  function legacyFsWriteName(expression) {
    const callee = unwrapExpression(expression);
    if (ts.isPropertyAccessExpression(callee)) {
      return legacyWriteCallees.has(callee.name.text) ? callee.name.text : null;
    }
    return ts.isIdentifier(callee) ? (fsWriteAliases.get(callee.text) ?? null) : null;
  }

  function isFsBindingExpression(expression) {
    const initializer = unwrapExpression(expression);
    if (ts.isIdentifier(initializer)) {
      return fsModuleBindings.has(initializer.text);
    }
    return (
      ts.isPropertyAccessExpression(initializer) &&
      initializer.name.text === "promises" &&
      ts.isIdentifier(initializer.expression) &&
      fsModuleBindings.has(initializer.expression.text)
    );
  }

  function collectFsWriteAliasesFromBinding(node) {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isObjectBindingPattern(node.name) ||
      !node.initializer
    ) {
      return;
    }
    if (!isFsBindingExpression(node.initializer)) {
      return;
    }
    for (const element of node.name.elements) {
      const propertyName = element.propertyName;
      const bindingName = element.name;
      const importedName =
        propertyName && ts.isIdentifier(propertyName)
          ? propertyName.text
          : ts.isIdentifier(bindingName)
            ? bindingName.text
            : null;
      if (!importedName || !legacyWriteCallees.has(importedName) || !ts.isIdentifier(bindingName)) {
        continue;
      }
      fsWriteAliases.set(bindingName.text, importedName);
    }
  }

  function pathArgumentsForFsWrite(name, args) {
    if (
      name === "appendRegularFile" ||
      name === "appendRegularFileSync" ||
      name === "replaceFileAtomic" ||
      name === "replaceFileAtomicSync"
    ) {
      const first = args[0];
      if (!first || !ts.isObjectLiteralExpression(unwrapExpression(first))) {
        return first ? [first] : [];
      }
      const objectArg = unwrapExpression(first);
      return objectArg.properties.flatMap((property) => {
        if (ts.isPropertyAssignment(property)) {
          const key = property.name;
          const propertyName =
            ts.isIdentifier(key) || ts.isStringLiteral(key) || ts.isNumericLiteral(key)
              ? key.text
              : null;
          return propertyName === "filePath" ? [property.initializer] : [];
        }
        if (ts.isShorthandPropertyAssignment(property) && property.name.text === "filePath") {
          return [property.name];
        }
        return [];
      });
    }
    if (
      name === "writeJson" ||
      name === "writeJsonAtomic" ||
      name === "writeJsonFileAtomically" ||
      name === "writeJsonSync" ||
      name === "writeTextAtomic"
    ) {
      return args.slice(0, 1);
    }
    if (
      name === "copyFile" ||
      name === "copyFileSync" ||
      name === "rename" ||
      name === "renameSync"
    ) {
      return args.slice(0, 2);
    }
    return args.slice(0, 1);
  }

  function pathArgumentContainsLegacyStore(argument) {
    return expressionContainsLegacyStore(argument);
  }

  function visit(node) {
    if (ts.isFunctionLike(node)) {
      visitFunctionLike(node);
      return;
    }

    if (ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node)) {
      visitWithChildScope(node);
      return;
    }

    collectFsWriteAliasesFromBinding(node);

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (isFsBindingExpression(node.initializer)) {
        fsModuleBindings.add(node.name.text);
      }
      currentLegacyPathScope().set(node.name.text, expressionContainsLegacyStore(node.initializer));
    }

    if (ts.isCallExpression(node)) {
      const fsWriteName = legacyFsWriteName(node.expression);
      if (
        fsWriteName &&
        pathArgumentsForFsWrite(fsWriteName, [...node.arguments]).some((argument) =>
          pathArgumentContainsLegacyStore(argument),
        )
      ) {
        addViolation(node.expression, "legacy store filesystem write");
      }
    }

    if (
      (ts.isStringLiteralLike(node) || ts.isIdentifier(node)) &&
      bridgeMarkerPattern.test(node.getText(sourceFile))
    ) {
      addViolation(node, "legacy transcript bridge marker");
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

/**
 * Runs the database-first legacy-store guard.
 */
export async function main() {
  const repoRoot = resolveRepoRoot(import.meta.url);
  const sourceRoots = databaseFirstLegacyStoreSourceRoots.map((root) => path.join(repoRoot, root));
  const files = await collectTypeScriptFilesFromRoots(sourceRoots, {
    extraTestSuffixes: [
      ".e2e-harness.ts",
      ".test-fixtures.ts",
      ".test-helper.ts",
      ".test-helpers.ts",
      ".test-mocks.ts",
      ".test-support.ts",
    ],
  });
  const violations = [];

  for (const filePath of files) {
    const relativePath = path.relative(repoRoot, filePath).replaceAll(path.sep, "/");
    const content = await fs.readFile(filePath, "utf8");
    for (const violation of collectDatabaseFirstLegacyStoreViolations(content, relativePath)) {
      violations.push(`${relativePath}:${violation.line} ${violation.kind}`);
    }
  }

  if (violations.length === 0) {
    console.log("Database-first legacy-store guard passed.");
    return;
  }

  console.error("Found database-first legacy-store guard violations:");
  for (const violation of violations.toSorted()) {
    console.error(`- ${violation}`);
  }
  console.error(
    "Runtime state/cache writes must use the shared or per-agent SQLite stores. Keep legacy file import/removal under doctor or migration owners.",
  );
  process.exit(1);
}

runAsScript(import.meta.url, main);
