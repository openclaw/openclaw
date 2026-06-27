#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import {
  collectFileViolations,
  resolveRepoRoot,
  resolveSourceRoots,
  runAsScript,
  toLine,
  unwrapExpression,
} from "./lib/ts-guard-utils.mjs";

const legacyTranscriptReaderModules = new Set([
  "../gateway/session-utils.js",
  "../gateway/session-utils.fs.js",
  "../../gateway/session-utils.js",
  "../../gateway/session-utils.fs.js",
  "./session-utils.js",
  "./session-utils.fs.js",
  "../session-utils.js",
  "../session-utils.fs.js",
]);

const transcriptReaderNames = new Set([
  "attachOpenClawTranscriptMeta",
  "capArrayByJsonBytes",
  "readFirstUserMessageFromTranscript",
  "readLatestRecentSessionUsageFromTranscriptAsync",
  "readLatestSessionUsageFromTranscript",
  "readLatestSessionUsageFromTranscriptAsync",
  "readRecentSessionMessages",
  "readRecentSessionMessagesAsync",
  "readRecentSessionMessagesWithStats",
  "readRecentSessionMessagesWithStatsAsync",
  "readRecentSessionTranscriptLines",
  "readRecentSessionUsageFromTranscript",
  "readRecentSessionUsageFromTranscriptAsync",
  "readSessionMessageByIdAsync",
  "readSessionMessageCount",
  "readSessionMessageCountAsync",
  "readSessionMessages",
  "readSessionMessagesAsync",
  "readSessionMessagesWithSourceAsync",
  "readSessionPreviewItemsFromTranscript",
  "readSessionTitleFieldsFromTranscript",
  "readSessionTitleFieldsFromTranscriptAsync",
  "visitSessionMessages",
  "visitSessionMessagesAsync",
]);

const storageSpecificTranscriptReaderAliasNames = new Set(["readSessionMessagesFromFileAsync"]);

const activeRuntimeJsonlTranscriptPersistenceNames = new Set([
  "appendAssistantMessageToSessionTranscript",
  "appendExactAssistantMessageToSessionTranscript",
  "appendSessionTranscriptEvent",
  "appendSessionTranscriptMessage",
  "appendSessionTranscriptMessageWithOwnedWriteLock",
  "runSessionTranscriptAppendTransaction",
  "withSessionTranscriptAppendQueue",
]);

const publicSdkFileTranscriptNamePattern =
  /\b(?:SessionTranscriptFile\w*|TranscriptFile\w*|transcriptFile\w*|FileTranscript\w*|FileTarget|SessionTranscriptUpdate)\b/u;

export const migratedSessionTranscriptReaderFiles = new Set([
  "src/agents/main-session-restart-recovery.ts",
  "src/agents/subagent-announce-output.test.ts",
  "src/agents/subagent-announce-output.ts",
  "src/agents/subagent-announce.runtime.ts",
  "src/agents/subagent-orphan-recovery.test.ts",
  "src/agents/subagent-orphan-recovery.ts",
  "src/agents/tools/embedded-gateway-stub.runtime.ts",
  "src/agents/tools/embedded-gateway-stub.test.ts",
  "src/agents/tools/embedded-gateway-stub.ts",
  "src/agents/tools/sessions-history-tool.ts",
  "src/agents/tools/sessions-list-tool.ts",
  "src/gateway/cli-session-history.claude.ts",
  "src/gateway/gateway-models.profiles.live.test.ts",
  "src/gateway/managed-image-attachments.test.ts",
  "src/gateway/managed-image-attachments.ts",
  "src/gateway/server-methods/artifacts.test.ts",
  "src/gateway/server-methods/artifacts.ts",
  "src/gateway/server-methods/chat.ts",
  "src/gateway/server-methods/sessions-files.test.ts",
  "src/gateway/server-methods/sessions-files.ts",
  "src/gateway/server-methods/sessions.ts",
  "src/gateway/server-session-events.ts",
  "src/gateway/session-history-state.test.ts",
  "src/gateway/session-history-state.ts",
  "src/gateway/session-reset-service.ts",
  "src/gateway/session-utils.ts",
  "src/gateway/sessions-history-http.revocation.test.ts",
  "src/gateway/sessions-history-http.ts",
  "src/status/status-message.ts",
  "src/tui/embedded-backend.test.ts",
  "src/tui/embedded-backend.ts",
]);

export const gatewayActiveTranscriptPersistenceRoots = ["src/gateway/server-methods"];

function normalizeRelativePath(filePath) {
  return filePath.replaceAll(path.sep, "/");
}

function importedModuleName(node) {
  return node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
    ? node.moduleSpecifier.text
    : null;
}

function bindingName(node) {
  if (node.propertyName && ts.isIdentifier(node.propertyName)) {
    return node.propertyName.text;
  }
  if (ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  return null;
}

function destructuresLegacyNamespace(node, legacyNamespaces) {
  const pattern = node.parent;
  const declaration = pattern?.parent;
  if (
    !pattern ||
    !ts.isObjectBindingPattern(pattern) ||
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !declaration.initializer
  ) {
    return false;
  }

  const initializer = unwrapExpression(declaration.initializer);
  return ts.isIdentifier(initializer) && legacyNamespaces.has(initializer.text);
}

export function findSessionTranscriptReaderBoundaryViolations(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const violations = [];
  const legacyNamespaces = new Set();

  const visit = (node) => {
    if (ts.isIdentifier(node) && storageSpecificTranscriptReaderAliasNames.has(node.text)) {
      violations.push({
        line: toLine(sourceFile, node),
        reason: `uses storage-specific transcript reader alias "${node.text}"`,
      });
    }

    if (ts.isImportDeclaration(node)) {
      const moduleName = importedModuleName(node);
      const namedBindings = node.importClause?.namedBindings;
      if (moduleName && legacyTranscriptReaderModules.has(moduleName) && namedBindings) {
        if (ts.isNamedImports(namedBindings)) {
          for (const specifier of namedBindings.elements) {
            const importedName = specifier.propertyName?.text ?? specifier.name.text;
            if (transcriptReaderNames.has(importedName)) {
              violations.push({
                line: toLine(sourceFile, specifier),
                reason: `imports transcript reader "${importedName}" from legacy module "${moduleName}"`,
              });
            }
          }
        } else if (ts.isNamespaceImport(namedBindings)) {
          legacyNamespaces.add(namedBindings.name.text);
        }
      }
    }

    if (ts.isExportDeclaration(node)) {
      const moduleName = importedModuleName(node);
      if (moduleName && legacyTranscriptReaderModules.has(moduleName)) {
        const exportClause = node.exportClause;
        if (!exportClause) {
          violations.push({
            line: toLine(sourceFile, node),
            reason: `re-exports transcript readers from legacy module "${moduleName}"`,
          });
        } else if (ts.isNamedExports(exportClause)) {
          for (const specifier of exportClause.elements) {
            const exportedName = specifier.propertyName?.text ?? specifier.name.text;
            if (transcriptReaderNames.has(exportedName)) {
              violations.push({
                line: toLine(sourceFile, specifier),
                reason: `re-exports transcript reader "${exportedName}" from legacy module "${moduleName}"`,
              });
            }
          }
        } else if (ts.isNamespaceExport(exportClause)) {
          violations.push({
            line: toLine(sourceFile, exportClause),
            reason: `re-exports transcript reader namespace from legacy module "${moduleName}"`,
          });
        }
      }
    }

    if (ts.isBindingElement(node)) {
      const name = bindingName(node);
      if (
        name &&
        transcriptReaderNames.has(name) &&
        destructuresLegacyNamespace(node, legacyNamespaces)
      ) {
        violations.push({
          line: toLine(sourceFile, node),
          reason: `aliases legacy transcript reader "${name}"`,
        });
      }
    }

    if (ts.isPropertyAccessExpression(node)) {
      const receiver = unwrapExpression(node.expression);
      if (
        ts.isIdentifier(receiver) &&
        legacyNamespaces.has(receiver.text) &&
        transcriptReaderNames.has(node.name.text)
      ) {
        violations.push({
          line: toLine(sourceFile, node.name),
          reason: `references legacy transcript reader "${node.name.text}"`,
        });
      }
    }

    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(unwrapExpression(node.expression)) &&
      legacyNamespaces.has(unwrapExpression(node.expression).text) &&
      ts.isStringLiteral(node.argumentExpression) &&
      transcriptReaderNames.has(node.argumentExpression.text)
    ) {
      violations.push({
        line: toLine(sourceFile, node.argumentExpression),
        reason: `references legacy transcript reader "${node.argumentExpression.text}"`,
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

export function findGatewayActiveJsonlTranscriptPersistenceViolations(
  content,
  fileName = "source.ts",
) {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const violations = [];

  const recordViolation = (node, name, action) => {
    violations.push({
      line: toLine(sourceFile, node),
      reason: `${action} active JSONL transcript persistence helper "${name}"`,
    });
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const namedBindings = node.importClause?.namedBindings;
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const specifier of namedBindings.elements) {
          const importedName = specifier.propertyName?.text ?? specifier.name.text;
          if (activeRuntimeJsonlTranscriptPersistenceNames.has(importedName)) {
            recordViolation(specifier, importedName, "imports");
          }
        }
      }
    }

    if (ts.isExportDeclaration(node)) {
      const exportClause = node.exportClause;
      if (exportClause && ts.isNamedExports(exportClause)) {
        for (const specifier of exportClause.elements) {
          const exportedName = specifier.propertyName?.text ?? specifier.name.text;
          if (activeRuntimeJsonlTranscriptPersistenceNames.has(exportedName)) {
            recordViolation(specifier, exportedName, "re-exports");
          }
        }
      }
    }

    if (ts.isBindingElement(node)) {
      const name = bindingName(node);
      if (name && activeRuntimeJsonlTranscriptPersistenceNames.has(name)) {
        recordViolation(node, name, "aliases");
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (
        ts.isIdentifier(callee) &&
        activeRuntimeJsonlTranscriptPersistenceNames.has(callee.text)
      ) {
        recordViolation(callee, callee.text, "calls");
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        activeRuntimeJsonlTranscriptPersistenceNames.has(callee.name.text)
      ) {
        recordViolation(callee.name, callee.name.text, "calls");
      } else if (
        ts.isElementAccessExpression(callee) &&
        ts.isStringLiteral(callee.argumentExpression) &&
        activeRuntimeJsonlTranscriptPersistenceNames.has(callee.argumentExpression.text)
      ) {
        recordViolation(callee.argumentExpression, callee.argumentExpression.text, "calls");
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

export function findPluginSdkApiBaselineFileTranscriptViolations(content) {
  const violations = [];
  const lines = content.split(/\r?\n/u);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!record || record.recordType !== "export") {
      return;
    }
    const exportName = typeof record.exportName === "string" ? record.exportName : "";
    const declaration = typeof record.declaration === "string" ? record.declaration : "";
    const haystack = `${exportName}\n${declaration}`;
    if (/\bsessionFile\b/u.test(declaration)) {
      violations.push({
        line: index + 1,
        reason: `public SDK API baseline exposes sessionFile transcript contract "${exportName}"`,
      });
      return;
    }
    if (publicSdkFileTranscriptNamePattern.test(haystack)) {
      violations.push({
        line: index + 1,
        reason: `public SDK API baseline exposes file-target transcript contract "${exportName}"`,
      });
    }
  });
  return violations;
}

function memberNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function typeNodeContainsSessionFileProperty(node) {
  if (!node) {
    return false;
  }
  let found = false;
  const visit = (current) => {
    if (
      ts.isPropertySignature(current) &&
      current.name &&
      memberNameText(current.name) === "sessionFile"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function findInterfaceMethod(sourceFile, interfaceName, methodName) {
  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName) {
      return statement.members.find(
        (member) =>
          ts.isMethodSignature(member) && member.name && memberNameText(member.name) === methodName,
      );
    }
  }
  return undefined;
}

function findTypeAlias(sourceFile, typeName) {
  return sourceFile.statements.find(
    (statement) => ts.isTypeAliasDeclaration(statement) && statement.name.text === typeName,
  );
}

export function findContextEngineCompactionSessionFileViolations(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const violations = [];
  const compactResult = findTypeAlias(sourceFile, "CompactResult");
  if (compactResult && typeNodeContainsSessionFileProperty(compactResult.type)) {
    violations.push({
      line: toLine(sourceFile, compactResult),
      reason: "CompactResult exposes active sessionFile identity; use sessionTarget",
    });
  }

  const compactMethod = findInterfaceMethod(sourceFile, "ContextEngine", "compact");
  const compactParam = compactMethod?.parameters[0];
  if (compactParam?.type && typeNodeContainsSessionFileProperty(compactParam.type)) {
    violations.push({
      line: toLine(sourceFile, compactParam),
      reason: "ContextEngine.compact exposes active sessionFile identity; use sessionTarget",
    });
  }
  return violations;
}

export async function main() {
  const repoRoot = resolveRepoRoot(import.meta.url);
  const sourceRoots = resolveSourceRoots(repoRoot, [
    "src/agents",
    "src/gateway",
    "src/status",
    "src/tui",
  ]);
  const violations = await collectFileViolations({
    repoRoot,
    sourceRoots,
    includeTests: true,
    skipFile: (filePath) =>
      !migratedSessionTranscriptReaderFiles.has(
        normalizeRelativePath(path.relative(repoRoot, filePath)),
      ),
    findViolations: findSessionTranscriptReaderBoundaryViolations,
  });
  const activeJsonlTranscriptPersistenceViolations = await collectFileViolations({
    repoRoot,
    sourceRoots: resolveSourceRoots(repoRoot, gatewayActiveTranscriptPersistenceRoots),
    findViolations: findGatewayActiveJsonlTranscriptPersistenceViolations,
  });
  const pluginSdkBaselinePath = path.join(
    repoRoot,
    "docs/.generated/plugin-sdk-api-baseline.jsonl",
  );
  const pluginSdkBaselineViolations = findPluginSdkApiBaselineFileTranscriptViolations(
    await fs.readFile(pluginSdkBaselinePath, "utf8"),
  ).map((violation) =>
    Object.assign({ path: "docs/.generated/plugin-sdk-api-baseline.jsonl" }, violation),
  );
  const contextEngineTypesPath = path.join(repoRoot, "src/context-engine/types.ts");
  const contextEngineCompactionViolations = findContextEngineCompactionSessionFileViolations(
    await fs.readFile(contextEngineTypesPath, "utf8"),
    contextEngineTypesPath,
  ).map((violation) => Object.assign({ path: "src/context-engine/types.ts" }, violation));
  violations.push(
    ...activeJsonlTranscriptPersistenceViolations,
    ...pluginSdkBaselineViolations,
    ...contextEngineCompactionViolations,
  );

  if (violations.length === 0) {
    console.log("session transcript reader boundary guard passed.");
    return;
  }

  console.error("Found legacy transcript reader usage in migrated files:");
  for (const violation of violations) {
    console.error(`- ${violation.path}:${violation.line}: ${violation.reason}`);
  }
  console.error(
    "Use src/gateway/session-transcript-readers.ts for migrated transcript reader paths. Live transcript persistence must use session-accessor/SQLite identity helpers, and public SDK/API baselines must not expose active transcript file targets.",
  );
  process.exit(1);
}

runAsScript(import.meta.url, main);
