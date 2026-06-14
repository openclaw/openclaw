#!/usr/bin/env node

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

const legacyReaderNames = new Set(["loadSessionStore", "readSessionEntries"]);
const legacyTranscriptWriterNames = new Set([
  "appendSessionTranscriptMessage",
  "emitSessionTranscriptUpdate",
]);

export const migratedSessionAccessorFiles = new Set([
  "src/config/sessions/combined-store-gateway.ts",
  "src/gateway/session-utils.ts",
  "src/gateway/sessions-resolve.ts",
  "src/gateway/server-methods/sessions.ts",
]);

export const migratedTranscriptWriterFiles = new Set([
  "src/agents/command/attempt-execution.ts",
  "src/config/sessions/transcript.ts",
  "src/gateway/server-methods/chat-transcript-inject.ts",
  "src/sessions/user-turn-transcript.ts",
]);

function normalizeRelativePath(filePath) {
  return filePath.replaceAll(path.sep, "/");
}

function propertyAccessName(expression) {
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
  return null;
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

export function findSessionAccessorBoundaryViolations(content, fileName = "source.ts") {
  return findNamedBoundaryViolations(content, fileName, {
    names: legacyReaderNames,
    subject: "legacy session store reader",
  });
}

export function findTranscriptWriterBoundaryViolations(content, fileName = "source.ts") {
  return findNamedBoundaryViolations(content, fileName, {
    names: legacyTranscriptWriterNames,
    subject: "legacy transcript writer",
  });
}

function findNamedBoundaryViolations(content, fileName, options) {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const violations = [];

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const namedBindings = node.importClause?.namedBindings;
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const specifier of namedBindings.elements) {
          const importedName = specifier.propertyName?.text ?? specifier.name.text;
          if (options.names.has(importedName)) {
            violations.push({
              line: toLine(sourceFile, specifier),
              reason: `imports ${options.subject} "${importedName}"`,
            });
          }
        }
      }
    }

    if (ts.isBindingElement(node)) {
      const name = bindingName(node);
      if (name && options.names.has(name)) {
        violations.push({
          line: toLine(sourceFile, node),
          reason: `aliases ${options.subject} "${name}"`,
        });
      }
    }

    if (ts.isPropertyAccessExpression(node) && options.names.has(node.name.text)) {
      violations.push({
        line: toLine(sourceFile, node.name),
        reason: `references ${options.subject} "${node.name.text}"`,
      });
    }

    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      options.names.has(node.argumentExpression.text)
    ) {
      violations.push({
        line: toLine(sourceFile, node.argumentExpression),
        reason: `references ${options.subject} "${node.argumentExpression.text}"`,
      });
    }

    if (ts.isCallExpression(node)) {
      const calleeName = propertyAccessName(node.expression);
      if (
        calleeName &&
        options.names.has(calleeName) &&
        ts.isIdentifier(unwrapExpression(node.expression))
      ) {
        violations.push({
          line: toLine(sourceFile, node.expression),
          reason: `calls ${options.subject} "${calleeName}"`,
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

export async function main() {
  const repoRoot = resolveRepoRoot(import.meta.url);
  const sourceRoots = resolveSourceRoots(repoRoot, [
    "src/agents/command",
    "src/config/sessions",
    "src/gateway",
    "src/sessions",
  ]);
  const violations = await collectFileViolations({
    repoRoot,
    sourceRoots,
    skipFile: (filePath) => {
      const relativePath = normalizeRelativePath(path.relative(repoRoot, filePath));
      return (
        !migratedSessionAccessorFiles.has(relativePath) &&
        !migratedTranscriptWriterFiles.has(relativePath)
      );
    },
    findViolations: (content, filePath) => {
      const relativePath = normalizeRelativePath(path.relative(repoRoot, filePath));
      return [
        ...(migratedSessionAccessorFiles.has(relativePath)
          ? findSessionAccessorBoundaryViolations(content, filePath)
          : []),
        ...(migratedTranscriptWriterFiles.has(relativePath)
          ? findTranscriptWriterBoundaryViolations(content, filePath)
          : []),
      ];
    },
  });

  if (violations.length === 0) {
    console.log("session accessor boundary guard passed.");
    return;
  }

  console.error("Found legacy session store reader usage in session-accessor migrated files:");
  for (const violation of violations) {
    console.error(`- ${violation.path}:${violation.line}: ${violation.reason}`);
  }
  console.error(
    "Use src/config/sessions/session-accessor.ts helpers for migrated read/projection and transcript-writer paths. Expand this ratchet only after a slice migrates more files.",
  );
  process.exit(1);
}

runAsScript(import.meta.url, main);
