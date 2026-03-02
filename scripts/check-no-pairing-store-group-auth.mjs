#!/usr/bin/env node

import path from "node:path";
import ts from "typescript";
import {
  collectFileViolations,
  getPropertyNameText,
  resolveRepoRoot,
  runAsScript,
  toLine,
} from "./lib/ts-guard-utils.mjs";

const repoRoot = resolveRepoRoot(import.meta.url);
const sourceRoots = [path.join(repoRoot, "src"), path.join(repoRoot, "extensions")];

const allowedFiles = new Set([
  path.join(repoRoot, "src", "security", "dm-policy-shared.ts"),
  path.join(repoRoot, "src", "channels", "allow-from.ts"),
  // Config migration/audit logic may intentionally reference store + group fields.
  path.join(repoRoot, "src", "security", "fix.ts"),
  path.join(repoRoot, "src", "security", "audit-channel.ts"),
]);

const storeIdentifierRe = /^(?:storeAllowFrom|storedAllowFrom|storeAllowList)$/i;
const groupNameRe =
  /(?:groupAllowFrom|effectiveGroupAllowFrom|groupAllowed|groupAllow|groupAuth|groupSender)/i;
const storeSourceCallNames = new Set([
  "readChannelAllowFromStore",
  "readChannelAllowFromStoreSync",
  "readStoreAllowFromForDmPolicy",
]);
const allowedResolverCallNames = new Set([
  "resolveEffectiveAllowFromLists",
  "resolveDmGroupAccessWithLists",
  "resolveMattermostEffectiveAllowFromLists",
  "resolveIrcEffectiveAllowlists",
]);

function getDeclarationNameText(name) {
  if (ts.isIdentifier(name)) {
    return name.text;
  }
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    return name.getText();
  }
  return null;
}

function containsPairingStoreSource(node) {
  let found = false;
  const visit = (current) => {
    if (found) {
      return;
    }
    if (ts.isIdentifier(current) && storeIdentifierRe.test(current.text)) {
      found = true;
      return;
    }
    if (ts.isCallExpression(current)) {
      const callName = getCallName(current);
      if (callName && storeSourceCallNames.has(callName)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function getCallName(node) {
  if (!ts.isCallExpression(node)) {
    return null;
  }
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text;
  }
  if (ts.isPropertyAccessExpression(node.expression)) {
    return node.expression.name.text;
  }
  return null;
}

function isSuspiciousNormalizeWithStoreCall(node) {
  if (!ts.isCallExpression(node)) {
    return false;
  }
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "normalizeAllowFromWithStore") {
    return false;
  }
  const firstArg = node.arguments[0];
  if (!firstArg || !ts.isObjectLiteralExpression(firstArg)) {
    return false;
  }
  let hasStoreProp = false;
  let hasGroupAllowProp = false;
  for (const property of firstArg.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const name = getPropertyNameText(property.name);
    if (!name) {
      continue;
    }
    if (name === "storeAllowFrom" && containsPairingStoreSource(property.initializer)) {
      hasStoreProp = true;
    }
    if (name === "allowFrom" && groupNameRe.test(property.initializer.getText())) {
      hasGroupAllowProp = true;
    }
  }
  return hasStoreProp && hasGroupAllowProp;
}

function findViolations(content, filePath) {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const violations = [];

  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const name = getDeclarationNameText(node.name);
      if (name && groupNameRe.test(name) && containsPairingStoreSource(node.initializer)) {
        const callName = getCallName(node.initializer);
        if (callName && allowedResolverCallNames.has(callName)) {
          ts.forEachChild(node, visit);
          return;
        }
        violations.push({
          line: toLine(sourceFile, node),
          reason: `group-scoped variable "${name}" references pairing-store identifiers`,
        });
      }
    }

    if (ts.isPropertyAssignment(node)) {
      const propName = getPropertyNameText(node.name);
      if (propName && groupNameRe.test(propName) && containsPairingStoreSource(node.initializer)) {
        violations.push({
          line: toLine(sourceFile, node),
          reason: `group-scoped property "${propName}" references pairing-store identifiers`,
        });
      }
    }

    if (isSuspiciousNormalizeWithStoreCall(node)) {
      violations.push({
        line: toLine(sourceFile, node),
        reason: "group allowlist uses normalizeAllowFromWithStore(...) with pairing-store entries",
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

async function main() {
  const violations = await collectFileViolations({
    sourceRoots,
    repoRoot,
    findViolations,
    skipFile: (filePath) => allowedFiles.has(filePath),
  });

  if (violations.length === 0) {
    return;
  }

  console.error("Found pairing-store identifiers referenced in group auth composition:");
  for (const violation of violations) {
    console.error(`- ${violation.path}:${violation.line} (${violation.reason})`);
  }
  console.error(
    "Group auth must be composed via shared resolvers (resolveDmGroupAccessWithLists / resolveEffectiveAllowFromLists).",
  );
  process.exit(1);
}

runAsScript(import.meta.url, main);
