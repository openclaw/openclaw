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

const fsModuleSpecifiers = new Set(["node:fs", "node:fs/promises", "fs", "fs/promises"]);

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

function collectCreateRequireBindings(sourceFile) {
  const bindings = new Set();
  function visit(node) {
    if (ts.isImportDeclaration(node) && ["node:module", "module"].includes(importSource(node))) {
      const namedBindings = node.importClause?.namedBindings;
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (importedName === "createRequire") {
            bindings.add(element.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return bindings;
}

function isFsRequireExpression(expression, isRequireShadowed = () => false) {
  const call = unwrapExpression(expression);
  if (!ts.isCallExpression(call) || !ts.isIdentifier(unwrapExpression(call.expression))) {
    return false;
  }
  const [specifier] = call.arguments;
  return (
    unwrapExpression(call.expression).text === "require" &&
    !isRequireShadowed() &&
    specifier &&
    ts.isStringLiteralLike(specifier) &&
    fsModuleSpecifiers.has(specifier.text)
  );
}

function unwrapAwaitExpression(expression) {
  const unwrapped = unwrapExpression(expression);
  return ts.isAwaitExpression(unwrapped) ? unwrapExpression(unwrapped.expression) : unwrapped;
}

function isFsDynamicImportExpression(expression) {
  const call = unwrapAwaitExpression(expression);
  if (!ts.isCallExpression(call) || call.expression.kind !== ts.SyntaxKind.ImportKeyword) {
    return false;
  }
  const [specifier] = call.arguments;
  return Boolean(
    specifier && ts.isStringLiteralLike(specifier) && fsModuleSpecifiers.has(specifier.text),
  );
}

function collectFsBindings(sourceFile) {
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
  const createRequireBindings = collectCreateRequireBindings(sourceFile);
  const { fsModuleBindings, fsWriteAliases } = collectFsBindings(sourceFile);
  const violations = [];
  const seenViolations = new Set();
  const fsModuleBindingScopes = [new Map([...fsModuleBindings].map((name) => [name, true]))];
  const fsModulePropertyScopes = [new Map()];
  const fsWriteAliasScopes = [fsWriteAliases];
  const requireShadowScopes = [new Set()];
  const createRequireShadowScopes = [new Set()];
  const legacyPathScopes = [new Map()];
  const legacyObjectPropertyScopes = [new Map()];
  const wrapperFunctionScopes = [new Map()];
  const conditionalExecutionScopes = [false];
  const branchEffectScopes = [];

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

  function currentFsWriteAliasScope() {
    return fsWriteAliasScopes[fsWriteAliasScopes.length - 1];
  }

  function currentFsModuleBindingScope() {
    return fsModuleBindingScopes[fsModuleBindingScopes.length - 1];
  }

  function currentFsModulePropertyScope() {
    return fsModulePropertyScopes[fsModulePropertyScopes.length - 1];
  }

  function currentRequireShadowScope() {
    return requireShadowScopes[requireShadowScopes.length - 1];
  }

  function isRequireShadowed() {
    return requireShadowScopes.some((scope) => scope.has("require"));
  }

  function isCreateRequireShadowed(name) {
    return createRequireShadowScopes.some((scope) => scope.has(name));
  }

  function isCreateRequireExpression(expression) {
    const call = unwrapExpression(expression);
    return (
      ts.isCallExpression(call) &&
      ts.isIdentifier(unwrapExpression(call.expression)) &&
      createRequireBindings.has(unwrapExpression(call.expression).text) &&
      !isCreateRequireShadowed(unwrapExpression(call.expression).text)
    );
  }

  function resolveFsModuleBinding(name) {
    for (let index = fsModuleBindingScopes.length - 1; index >= 0; index--) {
      const scope = fsModuleBindingScopes[index];
      if (scope.has(name)) {
        return scope.get(name) === true;
      }
    }
    return false;
  }

  function resolveFsModuleProperty(pathParts) {
    const fullPath = pathParts.join(".");
    const prefixes = pathParts.map((_, index) => pathParts.slice(0, index + 1).join("."));
    for (let index = fsModulePropertyScopes.length - 1; index >= 0; index--) {
      const scope = fsModulePropertyScopes[index];
      if (scope.has(fullPath)) {
        return scope.get(fullPath) === true;
      }
      for (const prefix of prefixes) {
        if (scope.get(prefix) === false) {
          return false;
        }
      }
    }
    return false;
  }

  function visibleFsModuleBindings() {
    const bindings = new Map();
    for (const scope of fsModuleBindingScopes) {
      for (const [name, value] of scope) {
        bindings.set(name, value);
      }
    }
    return bindings;
  }

  function visibleFsModuleProperties() {
    const properties = new Map();
    for (const scope of fsModulePropertyScopes) {
      for (const [name, value] of scope) {
        properties.set(name, value);
      }
    }
    return properties;
  }

  function resolveFsWriteAlias(name) {
    for (let index = fsWriteAliasScopes.length - 1; index >= 0; index--) {
      const scope = fsWriteAliasScopes[index];
      if (scope.has(name)) {
        return scope.get(name) ?? null;
      }
    }
    return null;
  }

  function visibleFsWriteAliases() {
    const aliases = new Map();
    for (const scope of fsWriteAliasScopes) {
      for (const [name, value] of scope) {
        aliases.set(name, value);
      }
    }
    return aliases;
  }

  function fsModuleBindingWriteScope(name) {
    for (let index = fsModuleBindingScopes.length - 1; index >= 0; index--) {
      const scope = fsModuleBindingScopes[index];
      if (scope.has(name)) {
        return scope;
      }
    }
    return currentFsModuleBindingScope();
  }

  function fsWriteAliasWriteScope(name) {
    for (let index = fsWriteAliasScopes.length - 1; index >= 0; index--) {
      const scope = fsWriteAliasScopes[index];
      if (scope.has(name)) {
        return scope;
      }
    }
    return currentFsWriteAliasScope();
  }

  function currentLegacyObjectPropertyScope() {
    return legacyObjectPropertyScopes[legacyObjectPropertyScopes.length - 1];
  }

  function currentWrapperFunctionScope() {
    return wrapperFunctionScopes[wrapperFunctionScopes.length - 1];
  }

  function currentConditionalExecutionScope() {
    return conditionalExecutionScopes[conditionalExecutionScopes.length - 1];
  }

  function currentBranchEffectScope() {
    return branchEffectScopes[branchEffectScopes.length - 1] ?? null;
  }

  function createBranchEffects() {
    return {
      fsIdentifierAssignments: new Map(),
      identifierAssignments: new Map(),
      propertyAssignments: new Map(),
      wrapperAssignments: new Map(),
    };
  }

  function objectPropertyKey(objectName, propertyName) {
    return `${objectName}.${propertyName}`;
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

  function resolveLegacyObjectProperty(objectName, propertyName) {
    return lookupLegacyObjectProperty(objectName, propertyName) === true;
  }

  function hasLegacyObjectPropertyEntry(objectName, propertyName) {
    const key = objectPropertyKey(objectName, propertyName);
    return legacyObjectPropertyScopes.some((propertyScope) => propertyScope.has(key));
  }

  function lookupLegacyObjectProperty(objectName, propertyName) {
    const key = objectPropertyKey(objectName, propertyName);
    for (let index = legacyObjectPropertyScopes.length - 1; index >= 0; index--) {
      const propertyScope = legacyObjectPropertyScopes[index];
      if (propertyScope.has(key)) {
        return propertyScope.get(key) === true;
      }
      if (legacyPathScopes[index].has(objectName)) {
        return legacyPathScopes[index].get(objectName) === true ? null : false;
      }
    }
    return null;
  }

  function elementAccessName(expression) {
    const argument = unwrapExpression(expression);
    return ts.isStringLiteral(argument) || ts.isNumericLiteral(argument) ? argument.text : null;
  }

  function propertyAccessPath(expression) {
    const unwrapped = unwrapExpression(expression);
    if (ts.isIdentifier(unwrapped)) {
      return [unwrapped.text];
    }
    if (ts.isPropertyAccessExpression(unwrapped)) {
      const parentPath = propertyAccessPath(unwrapped.expression);
      return parentPath ? [...parentPath, unwrapped.name.text] : null;
    }
    if (ts.isElementAccessExpression(unwrapped)) {
      const propertyName = elementAccessName(unwrapped.argumentExpression);
      if (!propertyName) {
        return null;
      }
      const parentPath = propertyAccessPath(unwrapped.expression);
      return parentPath ? [...parentPath, propertyName] : null;
    }
    return null;
  }

  function namedObjectPropertyAccess(expression) {
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
      return {
        objectName: expression.expression.text,
        propertyName: expression.name.text,
      };
    }
    if (ts.isElementAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
      const propertyName = elementAccessName(expression.argumentExpression);
      return propertyName
        ? {
            objectName: expression.expression.text,
            propertyName,
          }
        : null;
    }
    return null;
  }

  function legacyObjectPropertyWriteTarget(objectName, propertyName) {
    const key = objectPropertyKey(objectName, propertyName);
    for (let index = legacyObjectPropertyScopes.length - 1; index >= 0; index--) {
      const propertyScope = legacyObjectPropertyScopes[index];
      if (propertyScope.has(key) || legacyPathScopes[index].has(objectName)) {
        return { index, scope: propertyScope };
      }
    }
    return {
      index: legacyObjectPropertyScopes.length - 1,
      scope: currentLegacyObjectPropertyScope(),
    };
  }

  function legacyIdentifierWriteScopes(name) {
    for (let index = legacyPathScopes.length - 1; index >= 0; index--) {
      if (legacyPathScopes[index].has(name)) {
        return {
          index,
          pathScope: legacyPathScopes[index],
          propertyScope: legacyObjectPropertyScopes[index],
          wrapperScope: wrapperFunctionScopes[index],
        };
      }
    }
    return {
      index: legacyPathScopes.length - 1,
      pathScope: currentLegacyPathScope(),
      propertyScope: currentLegacyObjectPropertyScope(),
      wrapperScope: currentWrapperFunctionScope(),
    };
  }

  function isConditionallyExecutedScope(node) {
    const parent = node.parent;
    return Boolean(
      (ts.isBlock(node) &&
        parent &&
        ((ts.isIfStatement(parent) &&
          (parent.thenStatement === node || parent.elseStatement === node)) ||
          (ts.isIterationStatement(parent, false) && parent.statement === node) ||
          (ts.isTryStatement(parent) && parent.tryBlock === node))) ||
      ts.isCaseBlock(node) ||
      ts.isCatchClause(node),
    );
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
      const propertyAccess = namedObjectPropertyAccess(current);
      if (propertyAccess) {
        const propertyValue = lookupLegacyObjectProperty(
          propertyAccess.objectName,
          propertyAccess.propertyName,
        );
        if (propertyValue !== null) {
          found = propertyValue;
          return;
        }
      }
      ts.forEachChild(current, visitExpression);
    }
    visitExpression(node);
    return found;
  }

  function visitWithChildScope(node) {
    fsWriteAliasScopes.push(new Map());
    fsModuleBindingScopes.push(new Map());
    fsModulePropertyScopes.push(new Map());
    requireShadowScopes.push(new Set());
    createRequireShadowScopes.push(new Set());
    legacyPathScopes.push(new Map());
    legacyObjectPropertyScopes.push(new Map());
    wrapperFunctionScopes.push(new Map());
    conditionalExecutionScopes.push(
      currentConditionalExecutionScope() || isConditionallyExecutedScope(node),
    );
    if ("statements" in node) {
      registerHoistedWrapperFunctions(node.statements);
    }
    ts.forEachChild(node, visit);
    conditionalExecutionScopes.pop();
    wrapperFunctionScopes.pop();
    legacyObjectPropertyScopes.pop();
    legacyPathScopes.pop();
    fsModulePropertyScopes.pop();
    fsModuleBindingScopes.pop();
    fsWriteAliasScopes.pop();
    createRequireShadowScopes.pop();
    requireShadowScopes.pop();
  }

  function registerFsBindingParameter(name) {
    if (ts.isIdentifier(name)) {
      currentFsModuleBindingScope().set(name.text, true);
      return;
    }
    if (!ts.isObjectBindingPattern(name)) {
      return;
    }
    for (const element of name.elements) {
      const importedName = element.propertyName
        ? propertyNameText(element.propertyName)
        : ts.isIdentifier(element.name)
          ? element.name.text
          : null;
      if (importedName === "promises") {
        if (ts.isIdentifier(element.name)) {
          currentFsModuleBindingScope().set(element.name.text, true);
        } else if (ts.isObjectBindingPattern(element.name)) {
          registerFsPromisesBindingParameter(element.name);
        }
      }
      if (importedName && legacyWriteCallees.has(importedName) && ts.isIdentifier(element.name)) {
        currentFsWriteAliasScope().set(element.name.text, importedName);
      }
    }
  }

  function registerFsPromisesBindingParameter(name) {
    if (!ts.isObjectBindingPattern(name)) {
      return;
    }
    for (const element of name.elements) {
      const importedName = element.propertyName
        ? propertyNameText(element.propertyName)
        : ts.isIdentifier(element.name)
          ? element.name.text
          : null;
      if (importedName && legacyWriteCallees.has(importedName) && ts.isIdentifier(element.name)) {
        currentFsWriteAliasScope().set(element.name.text, importedName);
      }
      if (ts.isObjectBindingPattern(element.name)) {
        registerFsPromisesBindingParameter(element.name);
      }
    }
  }

  function visitFunctionLike(node, fsBindingParameterIndexes = new Set()) {
    fsWriteAliasScopes.push(new Map());
    fsModuleBindingScopes.push(new Map());
    fsModulePropertyScopes.push(new Map());
    requireShadowScopes.push(new Set());
    createRequireShadowScopes.push(new Set());
    legacyPathScopes.push(new Map());
    legacyObjectPropertyScopes.push(new Map());
    wrapperFunctionScopes.push(new Map());
    conditionalExecutionScopes.push(false);
    node.parameters.forEach((parameter, index) => {
      for (const name of bindingPatternNames(parameter.name)) {
        currentLegacyPathScope().set(name, false);
        currentWrapperFunctionScope().set(name, null);
      }
      markFsWriteAliasShadows(parameter.name);
      markFsModuleBindingShadows(parameter.name);
      markFsModulePropertyShadows(parameter.name);
      markRequireShadows(parameter.name);
      markCreateRequireShadows(parameter.name);
      registerFsModuleTypeProperties(parameter.name, parameter.type);
      if (fsBindingParameterIndexes.has(index)) {
        registerFsBindingParameter(parameter.name);
      }
    });
    ts.forEachChild(node, visit);
    conditionalExecutionScopes.pop();
    wrapperFunctionScopes.pop();
    legacyObjectPropertyScopes.pop();
    legacyPathScopes.pop();
    fsModulePropertyScopes.pop();
    fsModuleBindingScopes.pop();
    fsWriteAliasScopes.pop();
    createRequireShadowScopes.pop();
    requireShadowScopes.pop();
  }

  function dynamicFsImportThenCallback(node) {
    const callee = unwrapExpression(node.expression);
    if (
      !ts.isPropertyAccessExpression(callee) ||
      callee.name.text !== "then" ||
      !isFsDynamicImportExpression(callee.expression)
    ) {
      return null;
    }
    const [callback] = node.arguments;
    return callback && ts.isFunctionLike(callback) ? callback : null;
  }

  function isFsModuleExpression(expression) {
    const receiver = unwrapExpression(expression);
    if (
      isFsRequireExpression(receiver, isRequireShadowed) ||
      isFsDynamicImportExpression(receiver)
    ) {
      return true;
    }
    if (ts.isIdentifier(receiver)) {
      return resolveFsModuleBinding(receiver.text);
    }
    const receiverPath = propertyAccessPath(receiver);
    if (receiverPath && resolveFsModuleProperty(receiverPath)) {
      return true;
    }
    return (
      ts.isPropertyAccessExpression(receiver) &&
      receiver.name.text === "promises" &&
      (isFsRequireExpression(receiver.expression, isRequireShadowed) ||
        isFsDynamicImportExpression(receiver.expression) ||
        (ts.isIdentifier(receiver.expression) &&
          resolveFsModuleBinding(receiver.expression.text)) ||
        (propertyAccessPath(receiver.expression) &&
          resolveFsModuleProperty(propertyAccessPath(receiver.expression))))
    );
  }

  function legacyFsWriteName(expression, aliases = null) {
    const callee = unwrapExpression(expression);
    if (ts.isPropertyAccessExpression(callee)) {
      const aliasedName = callExpressionName(callee);
      const writeAlias = aliasedName ? resolveFsWriteAlias(aliasedName) : null;
      if (writeAlias) {
        return writeAlias;
      }
      return legacyWriteCallees.has(callee.name.text) && isFsModuleExpression(callee.expression)
        ? callee.name.text
        : null;
    }
    if (ts.isElementAccessExpression(callee)) {
      const aliasedName = callExpressionName(callee);
      const writeAlias = aliasedName ? resolveFsWriteAlias(aliasedName) : null;
      if (writeAlias) {
        return writeAlias;
      }
      const writeName = elementAccessName(callee.argumentExpression);
      return writeName &&
        legacyWriteCallees.has(writeName) &&
        isFsModuleExpression(callee.expression)
        ? writeName
        : null;
    }
    if (!ts.isIdentifier(callee)) {
      return null;
    }
    return aliases && aliases.has(callee.text)
      ? aliases.get(callee.text)
      : resolveFsWriteAlias(callee.text);
  }

  function markFsWriteAliasShadows(name) {
    for (const bindingName of bindingPatternNames(name)) {
      if (resolveFsWriteAlias(bindingName)) {
        currentFsWriteAliasScope().set(bindingName, null);
      }
    }
  }

  function markFsModuleBindingShadows(name) {
    for (const bindingName of bindingPatternNames(name)) {
      if (resolveFsModuleBinding(bindingName)) {
        currentFsModuleBindingScope().set(bindingName, false);
      }
    }
  }

  function markFsModulePropertyShadows(name) {
    for (const bindingName of bindingPatternNames(name)) {
      clearFsModuleObjectProperties(currentFsModulePropertyScope(), bindingName);
    }
  }

  function markRequireShadows(name) {
    if (bindingPatternNames(name).includes("require")) {
      currentRequireShadowScope().add("require");
    }
  }

  function markCreateRequireShadows(name) {
    for (const bindingName of bindingPatternNames(name)) {
      if (createRequireBindings.has(bindingName)) {
        createRequireShadowScopes[createRequireShadowScopes.length - 1].add(bindingName);
      }
    }
  }

  function isFsModuleTypeNode(type) {
    return Boolean(
      type &&
      /\btypeof\s+import\s*\(\s*["'](?:node:fs|node:fs\/promises|fs|fs\/promises)["']\s*\)/u.test(
        type.getText(sourceFile),
      ),
    );
  }

  function fsModulePropertyPathsFromType(type) {
    const paths = [];
    if (!type || !ts.isTypeLiteralNode(type)) {
      return paths;
    }
    for (const member of type.members) {
      if (!ts.isPropertySignature(member) || !member.type) {
        continue;
      }
      const propertyName = propertyNameText(member.name);
      if (!propertyName) {
        continue;
      }
      if (isFsModuleTypeNode(member.type)) {
        paths.push([propertyName]);
      }
      for (const nestedPath of fsModulePropertyPathsFromType(member.type)) {
        paths.push([propertyName, ...nestedPath]);
      }
    }
    return paths;
  }

  function registerFsModuleTypeProperties(name, type) {
    if (!ts.isIdentifier(name) || !type) {
      return;
    }
    if (isFsModuleTypeNode(type)) {
      currentFsModuleBindingScope().set(name.text, true);
    }
    for (const pathParts of fsModulePropertyPathsFromType(type)) {
      currentFsModulePropertyScope().set([name.text, ...pathParts].join("."), true);
    }
  }

  function collectFsWriteAliasesFromBinding(node) {
    collectFsWriteAliasesFromBindingInto(node, currentFsWriteAliasScope());
  }

  function clearFsWriteObjectAliases(scope, objectName) {
    const prefix = `${objectName}.`;
    for (const name of scope.keys()) {
      if (name.startsWith(prefix)) {
        scope.set(name, null);
      }
    }
  }

  function shadowVisibleFsWriteObjectAliases(objectName) {
    const prefix = `${objectName}.`;
    const currentScope = currentFsWriteAliasScope();
    for (const scope of fsWriteAliasScopes) {
      for (const name of scope.keys()) {
        if (name.startsWith(prefix)) {
          currentScope.set(name, null);
        }
      }
    }
  }

  function setFsWriteObjectAlias(scope, name, writeName, conditionalWrite) {
    if (writeName) {
      scope.set(name, writeName);
    } else if (!conditionalWrite) {
      scope.set(name, null);
    }
  }

  function registerFsWriteObjectAliases(
    objectName,
    initializer,
    scope = currentFsWriteAliasScope(),
    conditionalWrite = false,
  ) {
    const objectLiteral = unwrapExpression(initializer);
    if (!ts.isObjectLiteralExpression(objectLiteral)) {
      return;
    }
    for (const property of objectLiteral.properties) {
      if (ts.isPropertyAssignment(property)) {
        const name = propertyNameText(property.name);
        if (name) {
          setFsWriteObjectAlias(
            scope,
            `${objectName}.${name}`,
            legacyFsWriteName(property.initializer),
            conditionalWrite,
          );
        }
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        setFsWriteObjectAlias(
          scope,
          `${objectName}.${property.name.text}`,
          resolveFsWriteAlias(property.name.text),
          conditionalWrite,
        );
      }
    }
  }

  function setFsModuleObjectProperty(scope, name, isFsModule, conditionalWrite) {
    if (isFsModule) {
      scope.set(name, true);
    } else if (!conditionalWrite) {
      scope.set(name, false);
    }
  }

  function clearFsModuleObjectProperties(scope, objectName) {
    const prefix = `${objectName}.`;
    scope.set(objectName, false);
    for (const name of scope.keys()) {
      if (name.startsWith(prefix)) {
        scope.set(name, false);
      }
    }
  }

  function registerFsModuleObjectProperties(
    objectName,
    initializer,
    scope = currentFsModulePropertyScope(),
    conditionalWrite = false,
  ) {
    const objectLiteral = unwrapExpression(initializer);
    if (!ts.isObjectLiteralExpression(objectLiteral)) {
      return;
    }
    for (const property of objectLiteral.properties) {
      if (ts.isPropertyAssignment(property)) {
        const name = propertyNameText(property.name);
        if (name) {
          setFsModuleObjectProperty(
            scope,
            `${objectName}.${name}`,
            isFsModuleExpression(property.initializer),
            conditionalWrite,
          );
        }
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        setFsModuleObjectProperty(
          scope,
          `${objectName}.${property.name.text}`,
          resolveFsModuleBinding(property.name.text),
          conditionalWrite,
        );
      }
    }
  }

  function collectFsModuleBindingsFromBinding(node) {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isObjectBindingPattern(node.name) ||
      !node.initializer ||
      !isFsBindingExpression(node.initializer)
    ) {
      return;
    }
    for (const element of node.name.elements) {
      const propertyName = element.propertyName;
      const bindingName = element.name;
      const importedName = propertyName
        ? propertyNameText(propertyName)
        : ts.isIdentifier(bindingName)
          ? bindingName.text
          : null;
      if (importedName === "promises" && ts.isIdentifier(bindingName)) {
        currentFsModuleBindingScope().set(bindingName.text, true);
      }
    }
  }

  function isFsBindingExpression(expression) {
    const initializer = unwrapExpression(expression);
    if (
      isFsRequireExpression(initializer, isRequireShadowed) ||
      isFsDynamicImportExpression(initializer)
    ) {
      return true;
    }
    if (ts.isIdentifier(initializer)) {
      return resolveFsModuleBinding(initializer.text);
    }
    return (
      ts.isPropertyAccessExpression(initializer) &&
      initializer.name.text === "promises" &&
      (isFsRequireExpression(initializer.expression, isRequireShadowed) ||
        isFsDynamicImportExpression(initializer.expression) ||
        (ts.isIdentifier(initializer.expression) &&
          resolveFsModuleBinding(initializer.expression.text)))
    );
  }

  function collectFsWriteAliasesFromBindingInto(
    node,
    aliases,
    isFsBinding = isFsBindingExpression,
  ) {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isObjectBindingPattern(node.name) ||
      !node.initializer
    ) {
      return;
    }
    if (!isFsBinding(node.initializer)) {
      return;
    }
    collectFsWriteAliasesFromPattern(node.name, aliases);
  }

  function collectFsWriteAliasesFromPattern(pattern, aliases) {
    for (const element of pattern.elements) {
      const propertyName = element.propertyName;
      const bindingName = element.name;
      const importedName = propertyName
        ? propertyNameText(propertyName)
        : ts.isIdentifier(bindingName)
          ? bindingName.text
          : null;
      if (!importedName) {
        continue;
      }
      if (legacyWriteCallees.has(importedName) && ts.isIdentifier(bindingName)) {
        aliases.set(bindingName.text, importedName);
      }
      if (importedName === "promises" && ts.isObjectBindingPattern(bindingName)) {
        collectFsWriteAliasesFromPattern(bindingName, aliases);
      }
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

  function propertyNameText(name) {
    return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
      ? name.text
      : null;
  }

  function objectLiteralPropertyLegacyValue(objectLiteral, propertyName) {
    let result = null;
    for (const property of objectLiteral.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spreadExpression = unwrapExpression(property.expression);
        if (ts.isIdentifier(spreadExpression)) {
          const propertyValue = lookupLegacyObjectProperty(spreadExpression.text, propertyName);
          if (propertyValue !== null) {
            result = propertyValue;
          }
          continue;
        }
        if (ts.isObjectLiteralExpression(spreadExpression)) {
          const propertyValue = objectLiteralPropertyLegacyValue(spreadExpression, propertyName);
          if (propertyValue !== null) {
            result = propertyValue;
          }
        }
        continue;
      }
      if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === propertyName) {
        result = expressionContainsLegacyStore(property.initializer);
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === propertyName) {
        result = expressionContainsLegacyStore(property.name);
      }
    }
    return result;
  }

  function objectLiteralPropertyContainsLegacyStore(objectLiteral, propertyName) {
    return objectLiteralPropertyLegacyValue(objectLiteral, propertyName) === true;
  }

  function clearLegacyObjectProperties(scope, objectName) {
    const prefix = `${objectName}.`;
    for (const key of scope.keys()) {
      if (key.startsWith(prefix)) {
        scope.delete(key);
      }
    }
  }

  function legacyObjectPropertiesFromAssignment(objectName, initializer) {
    const properties = new Map();
    markLegacyObjectProperties(objectName, initializer, properties);
    return properties;
  }

  function branchIdentifierAssignmentKey(index, name) {
    return `${index}:${name}`;
  }

  function branchPropertyAssignmentKey(index, objectName, propertyName) {
    return `${index}:${objectPropertyKey(objectName, propertyName)}`;
  }

  function branchWrapperAssignmentKey(index, name) {
    return `${index}:${name}`;
  }

  function recordBranchIdentifierAssignment(index, name, value, initializer) {
    const effects = currentBranchEffectScope();
    if (!effects) {
      return;
    }
    effects.identifierAssignments.set(branchIdentifierAssignmentKey(index, name), {
      index,
      name,
      value,
      objectProperties: legacyObjectPropertiesFromAssignment(name, initializer),
    });
    const prefix = `${index}:${name}.`;
    for (const key of effects.propertyAssignments.keys()) {
      if (key.startsWith(prefix)) {
        effects.propertyAssignments.delete(key);
      }
    }
  }

  function recordBranchPropertyAssignment(index, objectName, propertyName, value) {
    const effects = currentBranchEffectScope();
    if (!effects) {
      return;
    }
    const identifierAssignment = effects.identifierAssignments.get(
      branchIdentifierAssignmentKey(index, objectName),
    );
    if (identifierAssignment) {
      identifierAssignment.objectProperties.set(objectPropertyKey(objectName, propertyName), value);
      return;
    }
    effects.propertyAssignments.set(branchPropertyAssignmentKey(index, objectName, propertyName), {
      index,
      objectName,
      propertyName,
      value,
    });
  }

  function recordBranchWrapperAssignment(index, name, value) {
    const effects = currentBranchEffectScope();
    if (!effects) {
      return;
    }
    effects.wrapperAssignments.set(branchWrapperAssignmentKey(index, name), {
      index,
      name,
      value: cloneWrapperFunctionValue(value),
    });
  }

  function recordBranchFsIdentifierAssignment(index, name, moduleValue, writeAlias) {
    const effects = currentBranchEffectScope();
    if (!effects) {
      return;
    }
    effects.fsIdentifierAssignments.set(branchIdentifierAssignmentKey(index, name), {
      index,
      moduleValue,
      name,
      writeAlias,
    });
  }

  function mergeWrapperAssignmentValues(left, right) {
    const records = [
      ...wrapperRecords(left).map(cloneWrapperRecord),
      ...wrapperRecords(right).map(cloneWrapperRecord),
    ];
    if (records.length === 0) {
      return null;
    }
    return records.length === 1 ? records[0] : records;
  }

  function mergeExhaustiveBranchEffects(thenEffects, elseEffects) {
    const mergedIdentifierNames = new Set();
    const parentEffect = currentBranchEffectScope();
    const applyToTargetScopes = !currentConditionalExecutionScope() && !parentEffect;
    for (const [key, thenAssignment] of thenEffects.fsIdentifierAssignments) {
      const elseAssignment = elseEffects.fsIdentifierAssignments.get(key);
      if (!elseAssignment) {
        continue;
      }
      const { index, name } = thenAssignment;
      const mergedModuleValue =
        thenAssignment.moduleValue === true || elseAssignment.moduleValue === true;
      const mergedWriteAlias = thenAssignment.writeAlias ?? elseAssignment.writeAlias;
      if (applyToTargetScopes) {
        fsModuleBindingScopes[index].set(name, mergedModuleValue);
        fsWriteAliasScopes[index].set(name, mergedWriteAlias);
      }
      currentFsModuleBindingScope().set(name, mergedModuleValue);
      currentFsWriteAliasScope().set(name, mergedWriteAlias);
      if (parentEffect) {
        parentEffect.fsIdentifierAssignments.set(branchIdentifierAssignmentKey(index, name), {
          index,
          moduleValue: mergedModuleValue,
          name,
          writeAlias: mergedWriteAlias,
        });
      }
    }
    for (const [key, thenAssignment] of thenEffects.identifierAssignments) {
      const elseAssignment = elseEffects.identifierAssignments.get(key);
      if (!elseAssignment) {
        continue;
      }
      const { index, name } = thenAssignment;
      mergedIdentifierNames.add(branchIdentifierAssignmentKey(index, name));
      const mergedValue = thenAssignment.value === true || elseAssignment.value === true;
      const propertyKeys = new Set([
        ...thenAssignment.objectProperties.keys(),
        ...elseAssignment.objectProperties.keys(),
      ]);
      const mergedProperties = new Map(
        [...propertyKeys].map((propertyKey) => [
          propertyKey,
          thenAssignment.objectProperties.get(propertyKey) === true ||
            elseAssignment.objectProperties.get(propertyKey) === true,
        ]),
      );
      if (applyToTargetScopes) {
        const pathScope = legacyPathScopes[index];
        const propertyScope = legacyObjectPropertyScopes[index];
        pathScope.set(name, mergedValue);
        clearLegacyObjectProperties(propertyScope, name);
        for (const [propertyKey, value] of mergedProperties) {
          propertyScope.set(propertyKey, value);
        }
      }
      currentLegacyPathScope().set(name, mergedValue);
      clearLegacyObjectProperties(currentLegacyObjectPropertyScope(), name);
      for (const [propertyKey, value] of mergedProperties) {
        currentLegacyObjectPropertyScope().set(propertyKey, value);
      }
      if (parentEffect) {
        parentEffect.identifierAssignments.set(branchIdentifierAssignmentKey(index, name), {
          index,
          name,
          value: mergedValue,
          objectProperties: mergedProperties,
        });
      }
    }
    for (const [key, thenAssignment] of thenEffects.propertyAssignments) {
      const elseAssignment = elseEffects.propertyAssignments.get(key);
      if (!elseAssignment) {
        continue;
      }
      const identifierKey = branchIdentifierAssignmentKey(
        thenAssignment.index,
        thenAssignment.objectName,
      );
      if (mergedIdentifierNames.has(identifierKey)) {
        continue;
      }
      const mergedValue = thenAssignment.value === true || elseAssignment.value === true;
      const propertyKey = objectPropertyKey(thenAssignment.objectName, thenAssignment.propertyName);
      if (applyToTargetScopes) {
        legacyObjectPropertyScopes[thenAssignment.index].set(propertyKey, mergedValue);
      }
      currentLegacyObjectPropertyScope().set(propertyKey, mergedValue);
      if (parentEffect) {
        recordBranchPropertyAssignment(
          thenAssignment.index,
          thenAssignment.objectName,
          thenAssignment.propertyName,
          mergedValue,
        );
      }
    }
    for (const [key, thenAssignment] of thenEffects.wrapperAssignments) {
      const elseAssignment = elseEffects.wrapperAssignments.get(key);
      if (!elseAssignment) {
        continue;
      }
      const { index, name } = thenAssignment;
      const mergedValue = mergeWrapperAssignmentValues(thenAssignment.value, elseAssignment.value);
      if (applyToTargetScopes) {
        wrapperFunctionScopes[index].set(name, cloneWrapperFunctionValue(mergedValue));
      }
      currentWrapperFunctionScope().set(name, cloneWrapperFunctionValue(mergedValue));
      const parentEffect = currentBranchEffectScope();
      if (parentEffect) {
        parentEffect.wrapperAssignments.set(branchWrapperAssignmentKey(index, name), {
          index,
          name,
          value: cloneWrapperFunctionValue(mergedValue),
        });
      }
    }
  }

  function markLegacyObjectProperties(
    objectName,
    initializer,
    targetScope = currentLegacyObjectPropertyScope(),
  ) {
    const objectLiteral = unwrapExpression(initializer);
    if (ts.isIdentifier(objectLiteral)) {
      copyLegacyObjectProperties(objectName, objectLiteral.text, targetScope);
      return;
    }
    if (!ts.isObjectLiteralExpression(objectLiteral)) {
      return;
    }
    for (const property of objectLiteral.properties) {
      if (ts.isPropertyAssignment(property)) {
        const name = propertyNameText(property.name);
        if (name) {
          targetScope.set(
            `${objectName}.${name}`,
            expressionContainsLegacyStore(property.initializer),
          );
          if (ts.isObjectLiteralExpression(unwrapExpression(property.initializer))) {
            markLegacyObjectProperties(`${objectName}.${name}`, property.initializer, targetScope);
          }
        }
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        targetScope.set(
          `${objectName}.${property.name.text}`,
          expressionContainsLegacyStore(property.name),
        );
        continue;
      }
      if (ts.isSpreadAssignment(property)) {
        const spreadExpression = unwrapExpression(property.expression);
        if (ts.isIdentifier(spreadExpression)) {
          copyLegacyObjectProperties(objectName, spreadExpression.text, targetScope);
        } else if (ts.isObjectLiteralExpression(spreadExpression)) {
          markLegacyObjectProperties(objectName, spreadExpression, targetScope);
        }
      }
    }
  }

  function copyLegacyObjectProperties(
    targetName,
    sourceName,
    targetScope = currentLegacyObjectPropertyScope(),
  ) {
    const sourcePrefix = `${sourceName}.`;
    for (let index = legacyObjectPropertyScopes.length - 1; index >= 0; index--) {
      const scope = legacyObjectPropertyScopes[index];
      let copied = false;
      for (const [key, value] of scope) {
        if (key.startsWith(sourcePrefix)) {
          targetScope.set(`${targetName}.${key.slice(sourcePrefix.length)}`, value);
          copied = true;
        }
      }
      if (copied || legacyPathScopes[index].has(sourceName)) {
        return;
      }
    }
  }

  function collectPathPropertyUses(
    expression,
    fsWriteName,
    resolveParameterIndex,
    resolveDestructuredParameterProperty,
    resolveParameterPropertyUse = null,
    resolveDestructuredParameterPropertyUses = null,
  ) {
    function appendUses(uses, value) {
      if (!value) {
        return;
      }
      if (Array.isArray(value)) {
        uses.push(...value);
        return;
      }
      uses.push(value);
    }

    const uses = [];
    function visitExpression(current) {
      if (
        ts.isIdentifier(current) &&
        usesFilePathOptionsObject(fsWriteName) &&
        resolveParameterIndex(current.text) !== null
      ) {
        const propertyUse = resolveParameterPropertyUse?.(current.text, "filePath");
        if (propertyUse !== null) {
          appendUses(
            uses,
            propertyUse ?? { index: resolveParameterIndex(current.text), propertyName: "filePath" },
          );
        }
        return;
      }
      const propertyAccess = namedObjectPropertyAccess(current);
      if (propertyAccess) {
        const index = resolveParameterIndex(propertyAccess.objectName);
        if (index !== null) {
          const propertyUse = resolveParameterPropertyUse?.(
            propertyAccess.objectName,
            propertyAccess.propertyName,
          );
          if (propertyUse !== null) {
            appendUses(uses, propertyUse ?? { index, propertyName: propertyAccess.propertyName });
          }
        }
        return;
      }
      if (ts.isIdentifier(current)) {
        const destructuredUses = resolveDestructuredParameterPropertyUses?.(current.text);
        if (destructuredUses) {
          appendUses(uses, destructuredUses);
        } else if (resolveDestructuredParameterProperty(current.text)) {
          uses.push(resolveDestructuredParameterProperty(current.text));
        } else {
          const index = resolveParameterIndex(current.text);
          if (index !== null) {
            uses.push({ index, propertyName: null });
          }
        }
      }
      ts.forEachChild(current, visitExpression);
    }
    visitExpression(expression);
    return uses;
  }

  function usesFilePathOptionsObject(name) {
    return (
      name === "appendRegularFile" ||
      name === "appendRegularFileSync" ||
      name === "replaceFileAtomic" ||
      name === "replaceFileAtomicSync"
    );
  }

  function parameterPropertyBindings(parameter, index) {
    const bindings = new Map();
    if (!ts.isObjectBindingPattern(parameter.name)) {
      return bindings;
    }
    for (const element of parameter.name.elements) {
      if (!ts.isIdentifier(element.name)) {
        continue;
      }
      const propertyName = element.propertyName
        ? propertyNameText(element.propertyName)
        : element.name.text;
      if (propertyName) {
        bindings.set(element.name.text, { index, propertyName });
      }
    }
    return bindings;
  }

  function bindingPatternNames(name) {
    const names = [];
    function visitName(current) {
      if (ts.isIdentifier(current)) {
        names.push(current.text);
        return;
      }
      if (ts.isObjectBindingPattern(current) || ts.isArrayBindingPattern(current)) {
        for (const element of current.elements) {
          if (ts.isBindingElement(element)) {
            visitName(element.name);
          }
        }
      }
    }
    visitName(name);
    return names;
  }

  function isParameterPropertyDestructure(node, parameterIndexes) {
    return (
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      parameterIndexes.has(node.initializer.text)
    );
  }

  function objectBindingParameterProperties(bindingPattern, index) {
    const bindings = new Map();
    for (const element of bindingPattern.elements) {
      if (!ts.isIdentifier(element.name)) {
        continue;
      }
      const propertyName = element.propertyName
        ? propertyNameText(element.propertyName)
        : element.name.text;
      if (propertyName) {
        bindings.set(element.name.text, { index, propertyName });
      }
    }
    return bindings;
  }

  function markLegacyPathsFromObjectBinding(bindingPattern, sourceName, propertyPath = []) {
    for (const element of bindingPattern.elements) {
      const propertyName = element.propertyName
        ? propertyNameText(element.propertyName)
        : ts.isIdentifier(element.name)
          ? element.name.text
          : null;
      if (!propertyName) {
        continue;
      }
      const nextPath = [...propertyPath, propertyName];
      if (ts.isIdentifier(element.name)) {
        const trackedPropertyValue = hasLegacyObjectPropertyEntry(sourceName, nextPath.join("."))
          ? lookupLegacyObjectProperty(sourceName, nextPath.join("."))
          : null;
        const propertyValue =
          trackedPropertyValue === null
            ? element.initializer
              ? expressionContainsLegacyStore(element.initializer)
              : false
            : trackedPropertyValue;
        currentLegacyPathScope().set(element.name.text, propertyValue);
        currentWrapperFunctionScope().set(
          element.name.text,
          cloneWrapperFunctionValue(resolveWrapperFunction(`${sourceName}.${nextPath.join(".")}`)),
        );
        continue;
      }
      if (ts.isObjectBindingPattern(element.name)) {
        markLegacyPathsFromObjectBinding(element.name, sourceName, nextPath);
      }
    }
  }

  function collectLegacyPathPropertyParameters(
    node,
    baseFsWriteAliases,
    baseFsModuleBindings,
    baseFsModuleProperties,
    activeWrapperNodes = new Set(),
  ) {
    if (activeWrapperNodes.has(node)) {
      return new Map();
    }
    activeWrapperNodes.add(node);
    const parameterIndexes = new Map();
    const bodyFsWriteAliasScopes = [new Map(baseFsWriteAliases)];
    const bodyFsModuleBindingScopes = [new Map(baseFsModuleBindings)];
    const bodyFsModulePropertyScopes = [new Map(baseFsModuleProperties)];
    const destructuredParameterPropertyScopes = [new Map()];
    const destructuredParameterPropertyMergeScopes = [new Map()];
    const parameterObjectBindingScopes = [new Map()];
    const parameterPropertyUseScopes = [new Map()];
    const conditionalDestructuredParameterPropertyScopes = [new Map()];
    const conditionalParameterObjectScopes = [new Map()];
    const conditionalParameterPropertyUseScopes = [new Map()];
    const conditionalWrapperBodyScopes = [false];
    const parameterObjectAssignmentShadowScopes = [new Set()];
    const shadowScopes = [new Set()];
    const fsAliasShadowScopes = [new Set()];
    const fsModuleShadowScopes = [new Set()];
    const wrapperRequireShadowScopes = [new Set()];
    const parameterObjectShadowScopes = [new Set()];
    const wrapperBranchEffectScopes = [];

    function currentBodyFsWriteAliasScope() {
      return bodyFsWriteAliasScopes[bodyFsWriteAliasScopes.length - 1];
    }

    function currentBodyFsModuleBindingScope() {
      return bodyFsModuleBindingScopes[bodyFsModuleBindingScopes.length - 1];
    }

    function currentBodyFsModulePropertyScope() {
      return bodyFsModulePropertyScopes[bodyFsModulePropertyScopes.length - 1];
    }

    function currentDestructuredParameterPropertyScope() {
      return destructuredParameterPropertyScopes[destructuredParameterPropertyScopes.length - 1];
    }

    function currentDestructuredParameterPropertyMergeScope() {
      return destructuredParameterPropertyMergeScopes[
        destructuredParameterPropertyMergeScopes.length - 1
      ];
    }

    function currentParameterObjectBindingScope() {
      return parameterObjectBindingScopes[parameterObjectBindingScopes.length - 1];
    }

    function currentParameterPropertyUseScope() {
      return parameterPropertyUseScopes[parameterPropertyUseScopes.length - 1];
    }

    function currentConditionalDestructuredParameterPropertyScope() {
      return conditionalDestructuredParameterPropertyScopes[
        conditionalDestructuredParameterPropertyScopes.length - 1
      ];
    }

    function currentConditionalParameterObjectScope() {
      return conditionalParameterObjectScopes[conditionalParameterObjectScopes.length - 1];
    }

    function currentConditionalParameterPropertyUseScope() {
      return conditionalParameterPropertyUseScopes[
        conditionalParameterPropertyUseScopes.length - 1
      ];
    }

    function currentConditionalWrapperBodyScope() {
      return conditionalWrapperBodyScopes[conditionalWrapperBodyScopes.length - 1];
    }

    function currentShadowScope() {
      return shadowScopes[shadowScopes.length - 1];
    }

    function currentFsAliasShadowScope() {
      return fsAliasShadowScopes[fsAliasShadowScopes.length - 1];
    }

    function currentFsModuleShadowScope() {
      return fsModuleShadowScopes[fsModuleShadowScopes.length - 1];
    }

    function currentParameterObjectShadowScope() {
      return parameterObjectShadowScopes[parameterObjectShadowScopes.length - 1];
    }

    function currentParameterObjectAssignmentShadowScope() {
      return parameterObjectAssignmentShadowScopes[
        parameterObjectAssignmentShadowScopes.length - 1
      ];
    }

    function currentWrapperBranchEffectScope() {
      return wrapperBranchEffectScopes[wrapperBranchEffectScopes.length - 1] ?? null;
    }

    function createWrapperBranchEffects() {
      return {
        destructuredAssignments: new Map(),
        parameterObjectAssignments: new Map(),
        parameterPropertyAssignments: new Map(),
      };
    }

    function bindingUses(binding) {
      return binding === null || binding === undefined ? [] : [binding];
    }

    function recordWrapperBranchParameterObjectAssignment(name, objectIndex) {
      const effects = currentWrapperBranchEffectScope();
      if (effects) {
        effects.parameterObjectAssignments.set(name, bindingUses(objectIndex));
      }
    }

    function recordWrapperBranchParameterPropertyAssignment(key, binding) {
      const effects = currentWrapperBranchEffectScope();
      if (effects) {
        effects.parameterPropertyAssignments.set(key, bindingUses(binding));
      }
    }

    function recordWrapperBranchDestructuredAssignment(name, binding) {
      const effects = currentWrapperBranchEffectScope();
      if (effects) {
        effects.destructuredAssignments.set(name, bindingUses(binding));
      }
    }

    function mergeBindingUses(left, right) {
      return [...left, ...right];
    }

    function applyMergedParameterPropertyAssignment(key, uses) {
      currentParameterPropertyUseScope().set(key, null);
      for (const use of uses) {
        appendConditionalUse(currentConditionalParameterPropertyUseScope(), key, use);
      }
      recordWrapperBranchParameterPropertyAssignment(key, uses[0] ?? null);
      const parentEffect = currentWrapperBranchEffectScope();
      if (parentEffect && uses.length > 1) {
        parentEffect.parameterPropertyAssignments.set(key, uses);
      }
    }

    function applyMergedDestructuredAssignment(name, uses) {
      currentDestructuredParameterPropertyScope().set(name, null);
      currentDestructuredParameterPropertyMergeScope().set(name, null);
      for (const use of uses) {
        appendConditionalUse(currentConditionalDestructuredParameterPropertyScope(), name, use);
      }
      recordWrapperBranchDestructuredAssignment(name, uses[0] ?? null);
      const parentEffect = currentWrapperBranchEffectScope();
      if (parentEffect && uses.length > 1) {
        parentEffect.destructuredAssignments.set(name, uses);
      }
    }

    function applyMergedParameterObjectAssignment(name, uses) {
      if (uses.length === 0) {
        currentParameterObjectShadowScope().add(name);
        currentParameterObjectAssignmentShadowScope().add(name);
      } else {
        currentParameterObjectBindingScope().set(name, uses[0]);
        for (const use of uses.slice(1)) {
          appendConditionalUse(currentConditionalParameterObjectScope(), name, use);
        }
      }
      const parentEffect = currentWrapperBranchEffectScope();
      if (parentEffect) {
        parentEffect.parameterObjectAssignments.set(name, uses);
      }
    }

    function mergeExhaustiveWrapperBranchEffects(thenEffects, elseEffects) {
      for (const [key, thenUses] of thenEffects.parameterPropertyAssignments) {
        const elseUses = elseEffects.parameterPropertyAssignments.get(key);
        if (elseUses) {
          applyMergedParameterPropertyAssignment(key, mergeBindingUses(thenUses, elseUses));
        }
      }
      for (const [name, thenUses] of thenEffects.destructuredAssignments) {
        const elseUses = elseEffects.destructuredAssignments.get(name);
        if (elseUses) {
          applyMergedDestructuredAssignment(name, mergeBindingUses(thenUses, elseUses));
        }
      }
      for (const [name, thenUses] of thenEffects.parameterObjectAssignments) {
        const elseUses = elseEffects.parameterObjectAssignments.get(name);
        if (elseUses) {
          applyMergedParameterObjectAssignment(name, mergeBindingUses(thenUses, elseUses));
        }
      }
    }

    function resolveParameterIndex(name) {
      for (let index = parameterObjectShadowScopes.length - 1; index >= 0; index--) {
        if (parameterObjectShadowScopes[index].has(name)) {
          return null;
        }
        if (parameterObjectBindingScopes[index].has(name)) {
          return parameterObjectBindingScopes[index].get(name);
        }
      }
      return parameterIndexes.has(name) ? parameterIndexes.get(name) : null;
    }

    function resolveDestructuredParameterProperty(name) {
      for (let index = destructuredParameterPropertyScopes.length - 1; index >= 0; index--) {
        if (shadowScopes[index].has(name)) {
          return null;
        }
        if (destructuredParameterPropertyScopes[index].has(name)) {
          return destructuredParameterPropertyScopes[index].get(name);
        }
      }
      return null;
    }

    function appendConditionalUse(scope, key, value) {
      const values = scope.get(key) ?? [];
      values.push(value);
      scope.set(key, values);
    }

    function conditionalUsesFor(key, scopes) {
      const uses = [];
      for (const scope of scopes) {
        uses.push(...(scope.get(key) ?? []));
      }
      return uses;
    }

    function conditionalObjectPropertyUses(objectName, propertyName) {
      const uses = [];
      for (const scope of conditionalParameterObjectScopes) {
        for (const index of scope.get(objectName) ?? []) {
          uses.push({ index, propertyName });
        }
      }
      return uses;
    }

    function resolveParameterPropertyUse(objectName, propertyName) {
      const key = `${objectName}.${propertyName}`;
      let baseUse = undefined;
      for (let index = parameterPropertyUseScopes.length - 1; index >= 0; index--) {
        if (parameterObjectShadowScopes[index].has(objectName)) {
          return null;
        }
        if (parameterPropertyUseScopes[index].has(key)) {
          baseUse = parameterPropertyUseScopes[index].get(key);
          break;
        }
      }
      const extraUses = [
        ...conditionalUsesFor(key, conditionalParameterPropertyUseScopes),
        ...conditionalObjectPropertyUses(objectName, propertyName),
      ];
      if (extraUses.length === 0) {
        return baseUse;
      }
      if (baseUse === null) {
        return extraUses;
      }
      const fallbackIndex = resolveParameterIndex(objectName);
      const baseUses = baseUse
        ? [baseUse]
        : fallbackIndex !== null
          ? [{ index: fallbackIndex, propertyName }]
          : [];
      return [...baseUses, ...extraUses];
    }

    function resolveDestructuredParameterPropertyUses(name) {
      const baseUse = resolveDestructuredParameterProperty(name);
      const extraUses = conditionalUsesFor(name, conditionalDestructuredParameterPropertyScopes);
      if (extraUses.length === 0) {
        return baseUse;
      }
      return baseUse ? [baseUse, ...extraUses] : extraUses;
    }

    function resolveParameterPropertyBinding(expression) {
      const unwrapped = unwrapExpression(expression);
      const propertyAccess = namedObjectPropertyAccess(unwrapped);
      if (propertyAccess) {
        const index = resolveParameterIndex(propertyAccess.objectName);
        if (index !== null) {
          return {
            index,
            propertyName: propertyAccess.propertyName,
          };
        }
      }
      if (ts.isIdentifier(unwrapped)) {
        return resolveDestructuredParameterProperty(unwrapped.text);
      }
      return null;
    }

    function resolveParameterObjectBindingExpression(expression) {
      const unwrapped = unwrapExpression(expression);
      return ts.isIdentifier(unwrapped) ? resolveParameterIndex(unwrapped.text) : null;
    }

    function collectForwardedWrapperPropertyUses(argument, propertyName) {
      if (propertyName === null) {
        return collectPathPropertyUses(
          argument,
          "writeFile",
          resolveParameterIndex,
          resolveDestructuredParameterProperty,
          resolveParameterPropertyUse,
          resolveDestructuredParameterPropertyUses,
        );
      }
      function collectForwardedWrapperPropertyUseState(currentArgument) {
        const currentUnwrapped = unwrapExpression(currentArgument);
        if (ts.isIdentifier(currentUnwrapped)) {
          const index = resolveParameterIndex(currentUnwrapped.text);
          if (index !== null) {
            const propertyUse = resolveParameterPropertyUse(currentUnwrapped.text, propertyName);
            return propertyUse === null ? [] : [propertyUse ?? { index, propertyName }];
          }
          return null;
        }
        if (ts.isObjectLiteralExpression(currentUnwrapped)) {
          let result = null;
          for (const property of currentUnwrapped.properties) {
            if (ts.isSpreadAssignment(property)) {
              const spreadUses = collectForwardedWrapperPropertyUseState(property.expression);
              if (spreadUses !== null) {
                result = spreadUses;
              }
              continue;
            }
            if (
              ts.isPropertyAssignment(property) &&
              propertyNameText(property.name) === propertyName
            ) {
              result = collectPathPropertyUses(
                property.initializer,
                "writeFile",
                resolveParameterIndex,
                resolveDestructuredParameterProperty,
                resolveParameterPropertyUse,
                resolveDestructuredParameterPropertyUses,
              );
              continue;
            }
            if (ts.isShorthandPropertyAssignment(property) && property.name.text === propertyName) {
              result = collectPathPropertyUses(
                property.name,
                "writeFile",
                resolveParameterIndex,
                resolveDestructuredParameterProperty,
                resolveParameterPropertyUse,
                resolveDestructuredParameterPropertyUses,
              );
            }
          }
          return result;
        }
        const uses = collectPathPropertyUses(
          currentArgument,
          "writeFile",
          resolveParameterIndex,
          resolveDestructuredParameterProperty,
          resolveParameterPropertyUse,
          resolveDestructuredParameterPropertyUses,
        );
        return uses.length > 0 ? uses : null;
      }
      const unwrapped = unwrapExpression(argument);
      if (ts.isIdentifier(unwrapped)) {
        const index = resolveParameterIndex(unwrapped.text);
        if (index !== null) {
          const propertyUse = resolveParameterPropertyUse(unwrapped.text, propertyName);
          return propertyUse === null ? [] : [propertyUse ?? { index, propertyName }];
        }
      }
      if (ts.isObjectLiteralExpression(unwrapped)) {
        return collectForwardedWrapperPropertyUseState(unwrapped) ?? [];
      }
      return collectPathPropertyUses(
        argument,
        "writeFile",
        resolveParameterIndex,
        resolveDestructuredParameterProperty,
        resolveParameterPropertyUse,
        resolveDestructuredParameterPropertyUses,
      );
    }

    function markParameterAssignment(node) {
      if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
        return;
      }
      if (ts.isIdentifier(node.left)) {
        if (resolveParameterIndex(node.left.text) !== null) {
          const objectIndex = resolveParameterObjectBindingExpression(node.right);
          if (currentConditionalWrapperBodyScope()) {
            recordWrapperBranchParameterObjectAssignment(node.left.text, objectIndex);
            if (objectIndex !== null) {
              appendConditionalUse(
                currentConditionalParameterObjectScope(),
                node.left.text,
                objectIndex,
              );
            }
          } else {
            if (objectIndex !== null) {
              currentParameterObjectBindingScope().set(node.left.text, objectIndex);
            } else {
              currentParameterObjectShadowScope().add(node.left.text);
              currentParameterObjectAssignmentShadowScope().add(node.left.text);
            }
          }
        }
        if (resolveDestructuredParameterProperty(node.left.text)) {
          const binding = resolveParameterPropertyBinding(node.right);
          if (currentConditionalWrapperBodyScope()) {
            recordWrapperBranchDestructuredAssignment(node.left.text, binding);
            if (binding) {
              appendConditionalUse(
                currentConditionalDestructuredParameterPropertyScope(),
                node.left.text,
                binding,
              );
            }
          } else {
            const updatesOuterBinding = !currentDestructuredParameterPropertyScope().has(
              node.left.text,
            );
            currentDestructuredParameterPropertyScope().set(node.left.text, binding);
            if (updatesOuterBinding) {
              currentDestructuredParameterPropertyMergeScope().set(node.left.text, binding);
            }
          }
        }
        return;
      }
      const propertyAccess = namedObjectPropertyAccess(node.left);
      if (propertyAccess && resolveParameterIndex(propertyAccess.objectName) !== null) {
        const binding = resolveParameterPropertyBinding(node.right);
        const key = `${propertyAccess.objectName}.${propertyAccess.propertyName}`;
        if (currentConditionalWrapperBodyScope()) {
          recordWrapperBranchParameterPropertyAssignment(key, binding);
          if (binding) {
            appendConditionalUse(currentConditionalParameterPropertyUseScope(), key, binding);
          }
        } else {
          currentParameterPropertyUseScope().set(key, binding);
        }
      }
    }

    function mergeConditionalUses(source, target) {
      for (const [key, uses] of source) {
        for (const use of uses) {
          appendConditionalUse(target, key, use);
        }
      }
    }

    function mergeMapEntries(source, target) {
      for (const [key, value] of source) {
        target.set(key, value);
      }
    }

    function mergeParameterObjectBindings(source, target) {
      for (const [key, value] of source) {
        if (parameterIndexes.has(key)) {
          target.set(key, value);
        }
      }
    }

    function pushWrapperBodyScope(
      conditional = currentConditionalWrapperBodyScope(),
      branchEffects = null,
    ) {
      bodyFsWriteAliasScopes.push(new Map());
      bodyFsModuleBindingScopes.push(new Map());
      bodyFsModulePropertyScopes.push(new Map());
      destructuredParameterPropertyScopes.push(new Map());
      destructuredParameterPropertyMergeScopes.push(new Map());
      parameterObjectBindingScopes.push(new Map());
      parameterPropertyUseScopes.push(new Map());
      conditionalDestructuredParameterPropertyScopes.push(new Map());
      conditionalParameterObjectScopes.push(new Map());
      conditionalParameterPropertyUseScopes.push(new Map());
      conditionalWrapperBodyScopes.push(conditional);
      shadowScopes.push(new Set());
      fsAliasShadowScopes.push(new Set());
      fsModuleShadowScopes.push(new Set());
      wrapperRequireShadowScopes.push(new Set());
      parameterObjectShadowScopes.push(new Set());
      parameterObjectAssignmentShadowScopes.push(new Set());
      wrapperBranchEffectScopes.push(branchEffects);
    }

    function popWrapperBodyScope() {
      wrapperBranchEffectScopes.pop();
      const parameterObjectAssignmentShadows = parameterObjectAssignmentShadowScopes.pop();
      parameterObjectShadowScopes.pop();
      wrapperRequireShadowScopes.pop();
      fsModuleShadowScopes.pop();
      fsAliasShadowScopes.pop();
      shadowScopes.pop();
      const parameterPropertyUses = conditionalParameterPropertyUseScopes.pop();
      const parameterObjectUses = conditionalParameterObjectScopes.pop();
      const destructuredUses = conditionalDestructuredParameterPropertyScopes.pop();
      const wasConditional = conditionalWrapperBodyScopes.pop();
      const directParameterPropertyUses = parameterPropertyUseScopes.pop();
      const directParameterObjectBindings = parameterObjectBindingScopes.pop();
      destructuredParameterPropertyScopes.pop();
      const directDestructuredBindings = destructuredParameterPropertyMergeScopes.pop();
      if (wasConditional) {
        mergeConditionalUses(parameterPropertyUses, currentConditionalParameterPropertyUseScope());
        mergeConditionalUses(parameterObjectUses, currentConditionalParameterObjectScope());
        mergeConditionalUses(
          destructuredUses,
          currentConditionalDestructuredParameterPropertyScope(),
        );
      } else {
        mergeMapEntries(directParameterPropertyUses, currentParameterPropertyUseScope());
        mergeParameterObjectBindings(
          directParameterObjectBindings,
          currentParameterObjectBindingScope(),
        );
        for (const name of parameterObjectAssignmentShadows) {
          currentParameterObjectShadowScope().add(name);
          currentParameterObjectAssignmentShadowScope().add(name);
        }
        mergeMapEntries(directDestructuredBindings, currentDestructuredParameterPropertyScope());
      }
      bodyFsModuleBindingScopes.pop();
      bodyFsModulePropertyScopes.pop();
      bodyFsWriteAliasScopes.pop();
    }

    function resolveBodyFsWriteAlias(name) {
      for (let index = bodyFsWriteAliasScopes.length - 1; index >= 0; index--) {
        const scope = bodyFsWriteAliasScopes[index];
        if (scope.has(name)) {
          return scope.get(name) ?? null;
        }
      }
      return null;
    }

    function resolveBodyFsModuleBinding(name) {
      for (let index = bodyFsModuleBindingScopes.length - 1; index >= 0; index--) {
        const scope = bodyFsModuleBindingScopes[index];
        if (scope.has(name)) {
          return scope.get(name) === true;
        }
      }
      return false;
    }

    function resolveBodyFsModuleProperty(pathParts) {
      const fullPath = pathParts.join(".");
      const prefixes = pathParts.map((_, index) => pathParts.slice(0, index + 1).join("."));
      for (let index = bodyFsModulePropertyScopes.length - 1; index >= 0; index--) {
        const scope = bodyFsModulePropertyScopes[index];
        if (scope.has(fullPath)) {
          return scope.get(fullPath) === true;
        }
        for (const prefix of prefixes) {
          if (scope.get(prefix) === false) {
            return false;
          }
        }
      }
      return false;
    }

    function isFsModuleShadowed(name) {
      for (let index = fsModuleShadowScopes.length - 1; index >= 0; index--) {
        if (fsModuleShadowScopes[index].has(name)) {
          return true;
        }
      }
      return false;
    }

    function isWrapperRequireShadowed() {
      return wrapperRequireShadowScopes.some((scope) => scope.has("require"));
    }

    function markWrapperRequireShadows(name) {
      if (bindingPatternNames(name).includes("require")) {
        wrapperRequireShadowScopes[wrapperRequireShadowScopes.length - 1].add("require");
      }
    }

    function shadowVisibleBodyFsWriteObjectAliases(objectName) {
      const prefix = `${objectName}.`;
      const currentScope = currentBodyFsWriteAliasScope();
      for (const scope of bodyFsWriteAliasScopes) {
        for (const name of scope.keys()) {
          if (name.startsWith(prefix)) {
            currentScope.set(name, null);
          }
        }
      }
    }

    function clearBodyFsWriteObjectAliases(scope, objectName) {
      const prefix = `${objectName}.`;
      for (const name of scope.keys()) {
        if (name.startsWith(prefix)) {
          scope.set(name, null);
        }
      }
    }

    function setBodyFsWriteObjectAlias(scope, name, writeName) {
      scope.set(name, writeName ?? null);
    }

    function registerBodyFsWriteObjectAliases(
      objectName,
      initializer,
      scope = currentBodyFsWriteAliasScope(),
    ) {
      const objectLiteral = unwrapExpression(initializer);
      if (!ts.isObjectLiteralExpression(objectLiteral)) {
        return;
      }
      for (const property of objectLiteral.properties) {
        if (ts.isPropertyAssignment(property)) {
          const name = propertyNameText(property.name);
          if (name) {
            setBodyFsWriteObjectAlias(
              scope,
              `${objectName}.${name}`,
              legacyWrapperFsWriteName(property.initializer),
            );
          }
          continue;
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          setBodyFsWriteObjectAlias(
            scope,
            `${objectName}.${property.name.text}`,
            resolveBodyFsWriteAlias(property.name.text),
          );
        }
      }
    }

    function isWrapperFsBindingExpression(expression) {
      const initializer = unwrapExpression(expression);
      if (
        isFsRequireExpression(initializer, isWrapperRequireShadowed) ||
        isFsDynamicImportExpression(initializer)
      ) {
        return true;
      }
      if (ts.isIdentifier(initializer)) {
        return (
          !isFsModuleShadowed(initializer.text) && resolveBodyFsModuleBinding(initializer.text)
        );
      }
      return (
        ts.isPropertyAccessExpression(initializer) &&
        initializer.name.text === "promises" &&
        (isFsRequireExpression(initializer.expression, isWrapperRequireShadowed) ||
          isFsDynamicImportExpression(initializer.expression) ||
          (ts.isIdentifier(initializer.expression) &&
            !isFsModuleShadowed(initializer.expression.text) &&
            resolveBodyFsModuleBinding(initializer.expression.text)))
      );
    }

    function isFsAliasShadowed(name) {
      for (let index = fsAliasShadowScopes.length - 1; index >= 0; index--) {
        if (fsAliasShadowScopes[index].has(name)) {
          return true;
        }
      }
      return false;
    }

    function isWrapperFsModuleExpression(expression) {
      const receiver = unwrapExpression(expression);
      if (
        isFsRequireExpression(receiver, isWrapperRequireShadowed) ||
        isFsDynamicImportExpression(receiver)
      ) {
        return true;
      }
      if (ts.isIdentifier(receiver)) {
        return !isFsModuleShadowed(receiver.text) && resolveBodyFsModuleBinding(receiver.text);
      }
      const receiverPath = propertyAccessPath(receiver);
      if (receiverPath && resolveBodyFsModuleProperty(receiverPath)) {
        return true;
      }
      return (
        ts.isPropertyAccessExpression(receiver) &&
        receiver.name.text === "promises" &&
        (isFsRequireExpression(receiver.expression, isWrapperRequireShadowed) ||
          isFsDynamicImportExpression(receiver.expression) ||
          (ts.isIdentifier(receiver.expression) &&
            !isFsModuleShadowed(receiver.expression.text) &&
            resolveBodyFsModuleBinding(receiver.expression.text)) ||
          (propertyAccessPath(receiver.expression) &&
            resolveBodyFsModuleProperty(propertyAccessPath(receiver.expression))))
      );
    }

    function legacyWrapperFsWriteName(expression) {
      const callee = unwrapExpression(expression);
      if (ts.isPropertyAccessExpression(callee)) {
        const aliasedName = callExpressionName(callee);
        const writeAlias =
          aliasedName && !isFsAliasShadowed(aliasedName)
            ? resolveBodyFsWriteAlias(aliasedName)
            : null;
        if (writeAlias) {
          return writeAlias;
        }
        return legacyWriteCallees.has(callee.name.text) &&
          isWrapperFsModuleExpression(callee.expression)
          ? callee.name.text
          : null;
      }
      if (ts.isElementAccessExpression(callee)) {
        const aliasedName = callExpressionName(callee);
        const writeAlias =
          aliasedName && !isFsAliasShadowed(aliasedName)
            ? resolveBodyFsWriteAlias(aliasedName)
            : null;
        if (writeAlias) {
          return writeAlias;
        }
        const writeName = elementAccessName(callee.argumentExpression);
        return writeName &&
          legacyWriteCallees.has(writeName) &&
          isWrapperFsModuleExpression(callee.expression)
          ? writeName
          : null;
      }
      if (ts.isIdentifier(callee) && isFsAliasShadowed(callee.text)) {
        return null;
      }
      return ts.isIdentifier(callee) ? resolveBodyFsWriteAlias(callee.text) : null;
    }

    function markFsAliasShadows(name) {
      for (const bindingName of bindingPatternNames(name)) {
        if (resolveBodyFsWriteAlias(bindingName)) {
          currentFsAliasShadowScope().add(bindingName);
        }
      }
    }

    function markFsModuleShadows(name) {
      for (const bindingName of bindingPatternNames(name)) {
        if (resolveBodyFsModuleBinding(bindingName)) {
          currentFsModuleShadowScope().add(bindingName);
          currentBodyFsModuleBindingScope().set(bindingName, false);
        }
        currentBodyFsModulePropertyScope().set(bindingName, false);
      }
    }

    function registerBodyFsModuleTypeProperties(name, type) {
      if (!ts.isIdentifier(name) || !type) {
        return;
      }
      if (isFsModuleTypeNode(type)) {
        currentBodyFsModuleBindingScope().set(name.text, true);
      }
      for (const pathParts of fsModulePropertyPathsFromType(type)) {
        currentBodyFsModulePropertyScope().set([name.text, ...pathParts].join("."), true);
      }
    }

    node.parameters.forEach((parameter, index) => {
      if (ts.isIdentifier(parameter.name)) {
        parameterIndexes.set(parameter.name.text, index);
      }
      markFsAliasShadows(parameter.name);
      markFsModuleShadows(parameter.name);
      markWrapperRequireShadows(parameter.name);
      registerBodyFsModuleTypeProperties(parameter.name, parameter.type);
      for (const [name, binding] of parameterPropertyBindings(parameter, index)) {
        currentDestructuredParameterPropertyScope().set(name, binding);
      }
    });

    const propertyUses = new Map();
    function visitBody(current) {
      if (current !== node && ts.isFunctionLike(current)) {
        return;
      }
      if (ts.isIfStatement(current)) {
        visitBody(current.expression);
        const thenEffects = current.elseStatement ? createWrapperBranchEffects() : null;
        const elseEffects = current.elseStatement ? createWrapperBranchEffects() : null;
        pushWrapperBodyScope(true, thenEffects);
        visitBody(current.thenStatement);
        popWrapperBodyScope();
        if (current.elseStatement) {
          pushWrapperBodyScope(true, elseEffects);
          visitBody(current.elseStatement);
          popWrapperBodyScope();
          mergeExhaustiveWrapperBranchEffects(thenEffects, elseEffects);
        }
        return;
      }
      if (ts.isWhileStatement(current)) {
        visitBody(current.expression);
        pushWrapperBodyScope(true);
        visitBody(current.statement);
        popWrapperBodyScope();
        return;
      }
      if (ts.isDoStatement(current)) {
        pushWrapperBodyScope(true);
        visitBody(current.statement);
        popWrapperBodyScope();
        visitBody(current.expression);
        return;
      }
      if (ts.isForStatement(current)) {
        pushWrapperBodyScope();
        if (current.initializer) {
          visitBody(current.initializer);
        }
        if (current.condition) {
          visitBody(current.condition);
        }
        if (current.incrementor) {
          pushWrapperBodyScope(true);
          visitBody(current.incrementor);
          popWrapperBodyScope();
        }
        pushWrapperBodyScope(true);
        visitBody(current.statement);
        popWrapperBodyScope();
        popWrapperBodyScope();
        return;
      }
      if (ts.isForInStatement(current) || ts.isForOfStatement(current)) {
        visitBody(current.expression);
        pushWrapperBodyScope();
        visitBody(current.initializer);
        pushWrapperBodyScope(true);
        visitBody(current.statement);
        popWrapperBodyScope();
        popWrapperBodyScope();
        return;
      }
      if (ts.isTryStatement(current)) {
        pushWrapperBodyScope(true);
        visitBody(current.tryBlock);
        popWrapperBodyScope();
        if (current.catchClause) {
          pushWrapperBodyScope(true);
          visitBody(current.catchClause);
          popWrapperBodyScope();
        }
        if (current.finallyBlock) {
          pushWrapperBodyScope();
          visitBody(current.finallyBlock);
          popWrapperBodyScope();
        }
        return;
      }
      if (
        current !== node.body &&
        (ts.isBlock(current) ||
          ts.isModuleBlock(current) ||
          ts.isCaseBlock(current) ||
          ts.isCatchClause(current))
      ) {
        pushWrapperBodyScope();
        ts.forEachChild(current, visitBody);
        popWrapperBodyScope();
        return;
      }
      if (ts.isVariableDeclaration(current)) {
        const isFsAliasBinding =
          ts.isObjectBindingPattern(current.name) &&
          current.initializer &&
          isWrapperFsBindingExpression(current.initializer);
        collectFsWriteAliasesFromBindingInto(
          current,
          currentBodyFsWriteAliasScope(),
          isWrapperFsBindingExpression,
        );
        if (ts.isIdentifier(current.name)) {
          shadowVisibleBodyFsWriteObjectAliases(current.name.text);
          if (current.initializer && isWrapperFsBindingExpression(current.initializer)) {
            currentBodyFsModuleBindingScope().set(current.name.text, true);
          } else {
            markFsModuleShadows(current.name);
          }
          markWrapperRequireShadows(current.name);
          if (current.initializer) {
            registerBodyFsWriteObjectAliases(current.name.text, current.initializer);
          }
        } else if (!isFsAliasBinding) {
          markFsModuleShadows(current.name);
          markWrapperRequireShadows(current.name);
        }
        const initializerPropertyAccess = current.initializer
          ? namedObjectPropertyAccess(current.initializer)
          : null;
        const initializerParameterIndex = initializerPropertyAccess
          ? resolveParameterIndex(initializerPropertyAccess.objectName)
          : null;
        const initializerObjectIndex =
          current.initializer && ts.isIdentifier(unwrapExpression(current.initializer))
            ? resolveParameterIndex(unwrapExpression(current.initializer).text)
            : null;
        if (isParameterPropertyDestructure(current, parameterIndexes)) {
          const index = parameterIndexes.get(current.initializer.text);
          for (const [name, binding] of objectBindingParameterProperties(current.name, index)) {
            currentDestructuredParameterPropertyScope().set(name, binding);
          }
        } else if (
          ts.isIdentifier(current.name) &&
          initializerPropertyAccess &&
          initializerParameterIndex !== null
        ) {
          currentDestructuredParameterPropertyScope().set(current.name.text, {
            index: initializerParameterIndex,
            propertyName: initializerPropertyAccess.propertyName,
          });
        } else if (ts.isIdentifier(current.name) && initializerObjectIndex !== null) {
          currentParameterObjectBindingScope().set(current.name.text, initializerObjectIndex);
        } else {
          for (const name of bindingPatternNames(current.name)) {
            if (resolveDestructuredParameterProperty(name)) {
              currentShadowScope().add(name);
            }
            if (parameterIndexes.has(name)) {
              currentParameterObjectShadowScope().add(name);
            }
          }
        }
        if (!isFsAliasBinding) {
          markFsAliasShadows(current.name);
        }
        if (ts.isIdentifier(current.name) && current.initializer) {
          currentBodyFsWriteAliasScope().set(
            current.name.text,
            legacyWrapperFsWriteName(current.initializer),
          );
        }
      }
      if (
        ts.isBinaryExpression(current) &&
        current.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(current.left)
      ) {
        currentBodyFsModuleBindingScope().set(
          current.left.text,
          isWrapperFsBindingExpression(current.right),
        );
        currentBodyFsWriteAliasScope().set(
          current.left.text,
          legacyWrapperFsWriteName(current.right),
        );
        shadowVisibleBodyFsWriteObjectAliases(current.left.text);
        clearBodyFsWriteObjectAliases(currentBodyFsWriteAliasScope(), current.left.text);
        registerBodyFsWriteObjectAliases(current.left.text, current.right);
      }
      if (
        ts.isBinaryExpression(current) &&
        current.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        namedObjectPropertyAccess(current.left)
      ) {
        const propertyAccess = namedObjectPropertyAccess(current.left);
        setBodyFsWriteObjectAlias(
          currentBodyFsWriteAliasScope(),
          objectPropertyKey(propertyAccess.objectName, propertyAccess.propertyName),
          legacyWrapperFsWriteName(current.right),
        );
      }
      markParameterAssignment(current);
      if (ts.isCallExpression(current)) {
        const fsWriteName = legacyWrapperFsWriteName(current.expression);
        if (fsWriteName) {
          for (const argument of pathArgumentsForFsWrite(fsWriteName, [...current.arguments])) {
            for (const use of collectPathPropertyUses(
              argument,
              fsWriteName,
              resolveParameterIndex,
              resolveDestructuredParameterProperty,
              resolveParameterPropertyUse,
              resolveDestructuredParameterPropertyUses,
            )) {
              const properties = propertyUses.get(use.index) ?? new Set();
              properties.add(use.propertyName);
              propertyUses.set(use.index, properties);
            }
          }
        }
        const wrapperName = callExpressionName(current.expression);
        const wrapperRecord = wrapperName ? resolveWrapperFunction(wrapperName) : null;
        for (const record of wrapperRecords(wrapperRecord)) {
          const forwardedPropertyUses = collectLegacyPathPropertyParameters(
            record.node,
            record.aliases,
            record.moduleBindings,
            record.moduleProperties,
            activeWrapperNodes,
          );
          for (const [index, propertyNames] of forwardedPropertyUses) {
            const argument = current.arguments[index];
            if (!argument) {
              continue;
            }
            for (const propertyName of propertyNames) {
              for (const use of collectForwardedWrapperPropertyUses(argument, propertyName)) {
                const properties = propertyUses.get(use.index) ?? new Set();
                properties.add(use.propertyName);
                propertyUses.set(use.index, properties);
              }
            }
          }
        }
      }
      ts.forEachChild(current, visitBody);
    }
    if (node.body) {
      visitBody(node.body);
    }
    activeWrapperNodes.delete(node);
    return propertyUses;
  }

  function wrapperRecordForNode(node) {
    return {
      aliases: visibleFsWriteAliases(),
      lexicalScopeIndex: wrapperFunctionScopes.length - 1,
      moduleBindings: visibleFsModuleBindings(),
      moduleProperties: visibleFsModuleProperties(),
      node,
    };
  }

  function registerWrapperFunction(name, node) {
    currentWrapperFunctionScope().set(name, wrapperRecordForNode(node));
  }

  function setWrapperFunctionValue(scope, name, value, conditionalWrite) {
    if (value) {
      if (conditionalWrite && scope.has(name)) {
        scope.set(name, [...wrapperRecords(scope.get(name)), ...wrapperRecords(value)]);
      } else {
        scope.set(name, value);
      }
    } else if (!conditionalWrite) {
      scope.set(name, null);
    }
  }

  function clearWrapperObjectMethods(scope, objectName) {
    const prefix = `${objectName}.`;
    for (const name of scope.keys()) {
      if (name.startsWith(prefix)) {
        scope.set(name, null);
      }
    }
  }

  function shadowVisibleWrapperObjectMethods(objectName) {
    const prefix = `${objectName}.`;
    const currentScope = currentWrapperFunctionScope();
    for (const scope of wrapperFunctionScopes) {
      for (const name of scope.keys()) {
        if (name.startsWith(prefix)) {
          currentScope.set(name, null);
        }
      }
    }
  }

  function registerWrapperObjectMethods(
    objectName,
    initializer,
    scope = currentWrapperFunctionScope(),
    conditionalWrite = false,
  ) {
    const objectLiteral = unwrapExpression(initializer);
    if (!ts.isObjectLiteralExpression(objectLiteral)) {
      return;
    }
    for (const property of objectLiteral.properties) {
      if (ts.isMethodDeclaration(property)) {
        const name = propertyNameText(property.name);
        if (name) {
          setWrapperFunctionValue(
            scope,
            `${objectName}.${name}`,
            wrapperRecordForNode(property),
            conditionalWrite,
          );
        }
        continue;
      }
      if (
        ts.isPropertyAssignment(property) &&
        (ts.isFunctionExpression(unwrapExpression(property.initializer)) ||
          ts.isArrowFunction(unwrapExpression(property.initializer)))
      ) {
        const name = propertyNameText(property.name);
        if (name) {
          setWrapperFunctionValue(
            scope,
            `${objectName}.${name}`,
            wrapperRecordForNode(unwrapExpression(property.initializer)),
            conditionalWrite,
          );
        }
        continue;
      }
      if (
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(unwrapExpression(property.initializer))
      ) {
        const name = propertyNameText(property.name);
        const wrapper = resolveWrapperFunction(unwrapExpression(property.initializer).text);
        if (name && wrapper) {
          setWrapperFunctionValue(
            scope,
            `${objectName}.${name}`,
            cloneWrapperFunctionValue(wrapper),
            conditionalWrite,
          );
        }
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        const wrapper = resolveWrapperFunction(property.name.text);
        if (wrapper) {
          setWrapperFunctionValue(
            scope,
            `${objectName}.${property.name.text}`,
            cloneWrapperFunctionValue(wrapper),
            conditionalWrite,
          );
        }
      }
    }
  }

  function wrapperRecords(value) {
    if (!value) {
      return [];
    }
    return Array.isArray(value) ? value : [value];
  }

  function cloneWrapperRecord(record) {
    return {
      aliases: new Map(record.aliases),
      lexicalScopeIndex: record.lexicalScopeIndex,
      moduleBindings: new Map(record.moduleBindings),
      moduleProperties: new Map(record.moduleProperties),
      node: record.node,
    };
  }

  function cloneWrapperFunctionValue(value) {
    if (!value) {
      return null;
    }
    const records = wrapperRecords(value).map(cloneWrapperRecord);
    return Array.isArray(value) ? records : records[0];
  }

  function refreshCurrentWrapperFunctionAliases() {
    const aliases = visibleFsWriteAliases();
    const moduleBindings = visibleFsModuleBindings();
    const moduleProperties = visibleFsModuleProperties();
    const currentLexicalScopeIndex = wrapperFunctionScopes.length - 1;
    for (const value of currentWrapperFunctionScope().values()) {
      for (const record of wrapperRecords(value)) {
        if (record.lexicalScopeIndex !== currentLexicalScopeIndex) {
          continue;
        }
        record.aliases = aliases;
        record.moduleBindings = moduleBindings;
        record.moduleProperties = moduleProperties;
      }
    }
  }

  function registerHoistedWrapperFunctions(statements) {
    for (const statement of statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        registerWrapperFunction(statement.name.text, statement);
      }
    }
  }

  function resolveWrapperFunction(name) {
    for (let index = wrapperFunctionScopes.length - 1; index >= 0; index--) {
      const wrapperScope = wrapperFunctionScopes[index];
      if (wrapperScope.has(name)) {
        return wrapperScope.get(name);
      }
      if (legacyPathScopes[index].has(name)) {
        return null;
      }
    }
    return null;
  }

  function resolveWrapperExpression(expression) {
    const unwrapped = unwrapExpression(expression);
    if (ts.isIdentifier(unwrapped)) {
      return resolveWrapperFunction(unwrapped.text);
    }
    const name = callExpressionName(unwrapped);
    return name ? resolveWrapperFunction(name) : null;
  }

  function pathArgumentContainsLegacyStore(argument) {
    return expressionContainsLegacyStore(argument);
  }

  function isUndefinedExpression(expression) {
    const unwrapped = unwrapExpression(expression);
    return ts.isIdentifier(unwrapped) && unwrapped.text === "undefined";
  }

  function callExpressionName(expression) {
    const callee = unwrapExpression(expression);
    if (ts.isIdentifier(callee)) {
      return callee.text;
    }
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
      return `${callee.expression.text}.${callee.name.text}`;
    }
    if (ts.isElementAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
      const propertyName = elementAccessName(callee.argumentExpression);
      return propertyName ? `${callee.expression.text}.${propertyName}` : null;
    }
    return null;
  }

  function objectArgumentPropertyContainsLegacyStore(argument, propertyName) {
    const unwrapped = unwrapExpression(argument);
    if (ts.isObjectLiteralExpression(unwrapped)) {
      return objectLiteralPropertyContainsLegacyStore(unwrapped, propertyName);
    }
    if (ts.isIdentifier(unwrapped)) {
      return resolveLegacyObjectProperty(unwrapped.text, propertyName);
    }
    return expressionContainsLegacyStore(argument);
  }

  function objectExpressionPropertyLegacyValue(expression, propertyName) {
    const unwrapped = unwrapExpression(expression);
    if (ts.isObjectLiteralExpression(unwrapped)) {
      return objectLiteralPropertyLegacyValue(unwrapped, propertyName);
    }
    if (ts.isIdentifier(unwrapped)) {
      return resolveLegacyObjectProperty(unwrapped.text, propertyName);
    }
    return null;
  }

  function objectLiteralPropertyDefaultApplies(objectLiteral, propertyName) {
    let state = "missing";
    for (const property of objectLiteral.properties) {
      if (ts.isSpreadAssignment(property)) {
        state = "unknown";
        continue;
      }
      if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === propertyName) {
        state = isUndefinedExpression(property.initializer) ? "undefined" : "present";
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === propertyName) {
        state = "present";
      }
    }
    return state === "missing" || state === "undefined";
  }

  function bindingElementDefaultInitializer(bindingPattern, propertyName) {
    for (const element of bindingPattern.elements) {
      const boundPropertyName = element.propertyName
        ? propertyNameText(element.propertyName)
        : ts.isIdentifier(element.name)
          ? element.name.text
          : null;
      if (boundPropertyName === propertyName) {
        return element.initializer ?? null;
      }
    }
    return null;
  }

  function wrapperObjectBindingDefaultContainsLegacyStore(
    parameter,
    propertyName,
    sourceExpression,
  ) {
    if (!parameter || !ts.isObjectBindingPattern(parameter.name) || !sourceExpression) {
      return false;
    }
    const initializer = bindingElementDefaultInitializer(parameter.name, propertyName);
    if (!initializer) {
      return false;
    }
    const source = unwrapExpression(sourceExpression);
    if (ts.isObjectLiteralExpression(source)) {
      return (
        objectLiteralPropertyDefaultApplies(source, propertyName) &&
        pathArgumentContainsLegacyStore(initializer)
      );
    }
    if (ts.isIdentifier(source)) {
      return (
        resolveLegacyObjectProperty(source.text, propertyName) === null &&
        pathArgumentContainsLegacyStore(initializer)
      );
    }
    return false;
  }

  function wrapperPathUseContainsLegacyStore(wrapperNode, index, propertyName, argument) {
    const parameter = wrapperNode.parameters[index] ?? null;
    const argumentUsesDefault = !argument || isUndefinedExpression(argument);
    if (propertyName === null) {
      if (!argumentUsesDefault) {
        return pathArgumentContainsLegacyStore(argument);
      }
      return !!parameter?.initializer && pathArgumentContainsLegacyStore(parameter.initializer);
    }
    if (!argumentUsesDefault) {
      if (objectArgumentPropertyContainsLegacyStore(argument, propertyName)) {
        return true;
      }
      return wrapperObjectBindingDefaultContainsLegacyStore(parameter, propertyName, argument);
    }
    if (parameter?.initializer) {
      const defaultPropertyValue = objectExpressionPropertyLegacyValue(
        parameter.initializer,
        propertyName,
      );
      if (defaultPropertyValue !== null) {
        return defaultPropertyValue;
      }
    }
    return wrapperObjectBindingDefaultContainsLegacyStore(
      parameter,
      propertyName,
      parameter?.initializer ?? null,
    );
  }

  function visitInConditionalExecution(node, branchEffects = null) {
    conditionalExecutionScopes.push(true);
    fsWriteAliasScopes.push(new Map());
    fsModuleBindingScopes.push(new Map());
    fsModulePropertyScopes.push(new Map());
    requireShadowScopes.push(new Set());
    createRequireShadowScopes.push(new Set());
    legacyPathScopes.push(new Map());
    legacyObjectPropertyScopes.push(new Map());
    wrapperFunctionScopes.push(new Map());
    branchEffectScopes.push(branchEffects);
    visit(node);
    branchEffectScopes.pop();
    wrapperFunctionScopes.pop();
    legacyObjectPropertyScopes.pop();
    legacyPathScopes.pop();
    fsModulePropertyScopes.pop();
    fsModuleBindingScopes.pop();
    fsWriteAliasScopes.pop();
    createRequireShadowScopes.pop();
    requireShadowScopes.pop();
    conditionalExecutionScopes.pop();
  }

  function visit(node) {
    if (node === sourceFile) {
      registerHoistedWrapperFunctions(sourceFile.statements);
    }

    if (ts.isIfStatement(node)) {
      visit(node.expression);
      const thenEffects = node.elseStatement ? createBranchEffects() : null;
      const elseEffects = node.elseStatement ? createBranchEffects() : null;
      visitInConditionalExecution(node.thenStatement, thenEffects);
      if (node.elseStatement) {
        visitInConditionalExecution(node.elseStatement, elseEffects);
        mergeExhaustiveBranchEffects(thenEffects, elseEffects);
      }
      return;
    }

    if (ts.isWhileStatement(node)) {
      visit(node.expression);
      visitInConditionalExecution(node.statement);
      return;
    }

    if (ts.isDoStatement(node)) {
      visitInConditionalExecution(node.statement);
      visit(node.expression);
      return;
    }

    if (ts.isForStatement(node)) {
      fsWriteAliasScopes.push(new Map());
      fsModuleBindingScopes.push(new Map());
      fsModulePropertyScopes.push(new Map());
      requireShadowScopes.push(new Set());
      createRequireShadowScopes.push(new Set());
      legacyPathScopes.push(new Map());
      legacyObjectPropertyScopes.push(new Map());
      wrapperFunctionScopes.push(new Map());
      conditionalExecutionScopes.push(false);
      if (node.initializer) {
        visit(node.initializer);
      }
      if (node.condition) {
        visit(node.condition);
      }
      if (node.incrementor) {
        visitInConditionalExecution(node.incrementor);
      }
      visitInConditionalExecution(node.statement);
      conditionalExecutionScopes.pop();
      wrapperFunctionScopes.pop();
      legacyObjectPropertyScopes.pop();
      legacyPathScopes.pop();
      fsModulePropertyScopes.pop();
      fsModuleBindingScopes.pop();
      fsWriteAliasScopes.pop();
      createRequireShadowScopes.pop();
      requireShadowScopes.pop();
      return;
    }

    if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      visit(node.expression);
      fsWriteAliasScopes.push(new Map());
      fsModuleBindingScopes.push(new Map());
      fsModulePropertyScopes.push(new Map());
      requireShadowScopes.push(new Set());
      createRequireShadowScopes.push(new Set());
      legacyPathScopes.push(new Map());
      legacyObjectPropertyScopes.push(new Map());
      wrapperFunctionScopes.push(new Map());
      conditionalExecutionScopes.push(true);
      visit(node.initializer);
      visit(node.statement);
      conditionalExecutionScopes.pop();
      wrapperFunctionScopes.pop();
      legacyObjectPropertyScopes.pop();
      legacyPathScopes.pop();
      fsModulePropertyScopes.pop();
      fsModuleBindingScopes.pop();
      fsWriteAliasScopes.pop();
      createRequireShadowScopes.pop();
      requireShadowScopes.pop();
      return;
    }

    if (ts.isFunctionLike(node)) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        registerWrapperFunction(node.name.text, node);
      }
      visitFunctionLike(node);
      return;
    }

    if (ts.isCallExpression(node)) {
      const callback = dynamicFsImportThenCallback(node);
      if (callback) {
        visitFunctionLike(callback, new Set([0]));
        for (const argument of node.arguments.slice(1)) {
          visit(argument);
        }
        return;
      }
    }

    if (
      ts.isBlock(node) ||
      ts.isModuleBlock(node) ||
      ts.isCaseBlock(node) ||
      ts.isCatchClause(node)
    ) {
      visitWithChildScope(node);
      return;
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.initializer) {
        if (isFsBindingExpression(node.initializer)) {
          currentFsModuleBindingScope().set(node.name.text, true);
        } else {
          markFsModuleBindingShadows(node.name);
        }
        markFsModulePropertyShadows(node.name);
        registerFsModuleTypeProperties(node.name, node.type);
        if (!(node.name.text === "require" && isCreateRequireExpression(node.initializer))) {
          markRequireShadows(node.name);
        }
        markCreateRequireShadows(node.name);
        collectFsWriteAliasesFromBinding(node);
        markFsWriteAliasShadows(node.name);
        currentFsWriteAliasScope().set(node.name.text, legacyFsWriteName(node.initializer));
        refreshCurrentWrapperFunctionAliases();
        currentLegacyPathScope().set(
          node.name.text,
          expressionContainsLegacyStore(node.initializer),
        );
        markLegacyObjectProperties(node.name.text, node.initializer);
        registerFsWriteObjectAliases(node.name.text, node.initializer);
        registerFsModuleObjectProperties(node.name.text, node.initializer);
        if (ts.isFunctionExpression(node.initializer) || ts.isArrowFunction(node.initializer)) {
          registerWrapperFunction(node.name.text, node.initializer);
        } else {
          currentWrapperFunctionScope().set(
            node.name.text,
            cloneWrapperFunctionValue(resolveWrapperExpression(node.initializer)),
          );
          registerWrapperObjectMethods(node.name.text, node.initializer);
        }
      } else {
        currentFsModuleBindingScope().set(node.name.text, false);
        currentFsWriteAliasScope().set(node.name.text, null);
        currentLegacyPathScope().set(node.name.text, false);
        currentWrapperFunctionScope().set(node.name.text, null);
        markFsWriteAliasShadows(node.name);
        markFsModuleBindingShadows(node.name);
        markFsModulePropertyShadows(node.name);
        registerFsModuleTypeProperties(node.name, node.type);
        markRequireShadows(node.name);
        markCreateRequireShadows(node.name);
        refreshCurrentWrapperFunctionAliases();
      }
    }
    if (ts.isVariableDeclaration(node) && !ts.isIdentifier(node.name)) {
      const isFsAliasBinding =
        node.initializer &&
        ts.isObjectBindingPattern(node.name) &&
        isFsBindingExpression(node.initializer);
      collectFsModuleBindingsFromBinding(node);
      collectFsWriteAliasesFromBinding(node);
      if (!isFsAliasBinding) {
        markFsWriteAliasShadows(node.name);
        markFsModuleBindingShadows(node.name);
        markFsModulePropertyShadows(node.name);
        markRequireShadows(node.name);
        markCreateRequireShadows(node.name);
      }
      refreshCurrentWrapperFunctionAliases();
      for (const name of bindingPatternNames(node.name)) {
        currentLegacyPathScope().set(name, false);
        currentWrapperFunctionScope().set(name, null);
      }
      if (
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        ts.isIdentifier(node.initializer)
      ) {
        markLegacyPathsFromObjectBinding(node.name, node.initializer.text);
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const { index, pathScope, propertyScope, wrapperScope } = legacyIdentifierWriteScopes(
        node.left.text,
      );
      const nextPathValue = expressionContainsLegacyStore(node.right);
      const nextFsModuleValue = isFsBindingExpression(node.right);
      const nextFsWriteAlias = legacyFsWriteName(node.right);
      const conditionalWrite =
        currentConditionalExecutionScope() && !conditionalExecutionScopes[index];
      pathScope.set(
        node.left.text,
        conditionalWrite ? pathScope.get(node.left.text) === true || nextPathValue : nextPathValue,
      );
      if (conditionalWrite) {
        recordBranchIdentifierAssignment(index, node.left.text, nextPathValue, node.right);
        const nextPropertyScope = new Map();
        markLegacyObjectProperties(node.left.text, node.right, nextPropertyScope);
        for (const [key, value] of nextPropertyScope) {
          propertyScope.set(key, propertyScope.get(key) === true || value);
        }
        currentLegacyPathScope().set(node.left.text, nextPathValue);
        clearLegacyObjectProperties(currentLegacyObjectPropertyScope(), node.left.text);
        markLegacyObjectProperties(node.left.text, node.right, currentLegacyObjectPropertyScope());
      } else {
        fsModuleBindingWriteScope(node.left.text).set(node.left.text, nextFsModuleValue);
        fsWriteAliasWriteScope(node.left.text).set(node.left.text, nextFsWriteAlias);
        markFsModulePropertyShadows(node.left);
        clearLegacyObjectProperties(propertyScope, node.left.text);
        markLegacyObjectProperties(node.left.text, node.right, propertyScope);
        clearFsWriteObjectAliases(fsWriteAliasScopes[index], node.left.text);
        registerFsWriteObjectAliases(node.left.text, node.right, fsWriteAliasScopes[index]);
        registerFsModuleObjectProperties(node.left.text, node.right, fsModulePropertyScopes[index]);
        clearWrapperObjectMethods(wrapperScope, node.left.text);
        registerWrapperObjectMethods(node.left.text, node.right, wrapperScope);
      }
      if (conditionalWrite) {
        const fsModuleScope = fsModuleBindingScopes[index];
        const fsWriteScope = fsWriteAliasScopes[index];
        fsModuleScope.set(
          node.left.text,
          fsModuleScope.get(node.left.text) === true || nextFsModuleValue,
        );
        fsWriteScope.set(node.left.text, fsWriteScope.get(node.left.text) ?? nextFsWriteAlias);
        currentFsModuleBindingScope().set(node.left.text, nextFsModuleValue);
        currentFsWriteAliasScope().set(node.left.text, nextFsWriteAlias);
        recordBranchFsIdentifierAssignment(
          index,
          node.left.text,
          nextFsModuleValue,
          nextFsWriteAlias,
        );
        registerFsWriteObjectAliases(node.left.text, node.right, fsWriteAliasScopes[index], true);
        registerFsModuleObjectProperties(
          node.left.text,
          node.right,
          fsModulePropertyScopes[index],
          true,
        );
        shadowVisibleFsWriteObjectAliases(node.left.text);
        registerFsWriteObjectAliases(node.left.text, node.right);
        registerFsModuleObjectProperties(node.left.text, node.right);
        registerWrapperObjectMethods(node.left.text, node.right, wrapperScope, true);
        shadowVisibleWrapperObjectMethods(node.left.text);
        registerWrapperObjectMethods(node.left.text, node.right);
      }
      const assignedWrapper =
        ts.isFunctionExpression(node.right) || ts.isArrowFunction(node.right)
          ? wrapperRecordForNode(node.right)
          : cloneWrapperFunctionValue(resolveWrapperExpression(node.right));
      if (conditionalWrite) {
        recordBranchWrapperAssignment(index, node.left.text, assignedWrapper);
      }
      setWrapperFunctionValue(wrapperScope, node.left.text, assignedWrapper, conditionalWrite);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      namedObjectPropertyAccess(node.left)
    ) {
      const propertyAccess = namedObjectPropertyAccess(node.left);
      const target = legacyObjectPropertyWriteTarget(
        propertyAccess.objectName,
        propertyAccess.propertyName,
      );
      const key = objectPropertyKey(propertyAccess.objectName, propertyAccess.propertyName);
      const nextValue = expressionContainsLegacyStore(node.right);
      const conditionalPropertyWrite =
        currentConditionalExecutionScope() && !conditionalExecutionScopes[target.index];
      target.scope.set(
        key,
        conditionalPropertyWrite ? target.scope.get(key) === true || nextValue : nextValue,
      );
      if (conditionalPropertyWrite) {
        currentLegacyObjectPropertyScope().set(key, nextValue);
        recordBranchPropertyAssignment(
          target.index,
          propertyAccess.objectName,
          propertyAccess.propertyName,
          nextValue,
        );
      }
      const wrapperTarget = legacyIdentifierWriteScopes(propertyAccess.objectName);
      const conditionalWrapperWrite =
        currentConditionalExecutionScope() && !conditionalExecutionScopes[wrapperTarget.index];
      setFsWriteObjectAlias(
        fsWriteAliasScopes[wrapperTarget.index],
        key,
        legacyFsWriteName(node.right),
        conditionalWrapperWrite,
      );
      setFsModuleObjectProperty(
        fsModulePropertyScopes[wrapperTarget.index],
        key,
        isFsModuleExpression(node.right),
        conditionalWrapperWrite,
      );
      if (conditionalWrapperWrite) {
        currentFsWriteAliasScope().set(key, legacyFsWriteName(node.right));
        currentFsModulePropertyScope().set(key, isFsModuleExpression(node.right));
      }
      const assignedWrapper =
        ts.isFunctionExpression(node.right) || ts.isArrowFunction(node.right)
          ? wrapperRecordForNode(node.right)
          : cloneWrapperFunctionValue(resolveWrapperExpression(node.right));
      if (conditionalWrapperWrite) {
        currentWrapperFunctionScope().set(key, assignedWrapper);
        recordBranchWrapperAssignment(wrapperTarget.index, key, assignedWrapper);
      }
      setWrapperFunctionValue(
        wrapperTarget.wrapperScope,
        key,
        assignedWrapper,
        conditionalWrapperWrite,
      );
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
      const wrapperName = callExpressionName(node.expression);
      const wrapperRecord = wrapperName ? resolveWrapperFunction(wrapperName) : null;
      for (const record of wrapperRecords(wrapperRecord)) {
        const propertyParameters = collectLegacyPathPropertyParameters(
          record.node,
          record.aliases,
          record.moduleBindings,
          record.moduleProperties,
        );
        for (const [index, propertyNames] of propertyParameters) {
          const argument = node.arguments[index];
          if (
            [...propertyNames].some((propertyName) =>
              wrapperPathUseContainsLegacyStore(record.node, index, propertyName, argument),
            )
          ) {
            addViolation(node.expression, "legacy store filesystem write");
            break;
          }
        }
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
