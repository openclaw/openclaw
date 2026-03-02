#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  collectTypeScriptFiles,
  resolveRepoRoot,
  runAsScript,
  toLine,
  unwrapExpression,
} from "./lib/ts-guard-utils.mjs";

const repoRoot = resolveRepoRoot(import.meta.url);
const sourceRoots = [
  path.join(repoRoot, "src", "channels"),
  path.join(repoRoot, "src", "infra", "outbound"),
  path.join(repoRoot, "src", "line"),
  path.join(repoRoot, "src", "media-understanding"),
  path.join(repoRoot, "extensions"),
];
const allowedCallsites = new Set([path.join(repoRoot, "extensions", "feishu", "src", "dedup.ts")]);

function collectOsTmpdirImports(sourceFile) {
  const osModuleSpecifiers = new Set(["node:os", "os"]);
  const osNamespaceOrDefault = new Set();
  const namedTmpdir = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    if (!statement.importClause || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    if (!osModuleSpecifiers.has(statement.moduleSpecifier.text)) {
      continue;
    }
    const clause = statement.importClause;
    if (clause.name) {
      osNamespaceOrDefault.add(clause.name.text);
    }
    if (!clause.namedBindings) {
      continue;
    }
    if (ts.isNamespaceImport(clause.namedBindings)) {
      osNamespaceOrDefault.add(clause.namedBindings.name.text);
      continue;
    }
    for (const element of clause.namedBindings.elements) {
      if ((element.propertyName?.text ?? element.name.text) === "tmpdir") {
        namedTmpdir.add(element.name.text);
      }
    }
  }
  return { osNamespaceOrDefault, namedTmpdir };
}

export function findMessagingTmpdirCallLines(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const { osNamespaceOrDefault, namedTmpdir } = collectOsTmpdirImports(sourceFile);
  const lines = [];

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "tmpdir" &&
        ts.isIdentifier(callee.expression) &&
        osNamespaceOrDefault.has(callee.expression.text)
      ) {
        lines.push(toLine(sourceFile, callee));
      } else if (ts.isIdentifier(callee) && namedTmpdir.has(callee.text)) {
        lines.push(toLine(sourceFile, callee));
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return lines;
}

export async function main() {
  const files = (
    await Promise.all(
      sourceRoots.map(
        async (dir) =>
          await collectTypeScriptFiles(dir, {
            ignoreMissing: true,
          }),
      ),
    )
  ).flat();
  const violations = [];

  for (const filePath of files) {
    if (allowedCallsites.has(filePath)) {
      continue;
    }
    const content = await fs.readFile(filePath, "utf8");
    for (const line of findMessagingTmpdirCallLines(content, filePath)) {
      violations.push(`${path.relative(repoRoot, filePath)}:${line}`);
    }
  }

  if (violations.length === 0) {
    return;
  }

  console.error("Found os.tmpdir()/tmpdir() usage in messaging/channel runtime sources:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  console.error(
    "Use resolvePreferredOpenClawTmpDir() or plugin-sdk temp helpers instead of host tmp defaults.",
  );
  process.exit(1);
}

runAsScript(import.meta.url, main);
