#!/usr/bin/env node

import path from "node:path";
import ts from "typescript";
import { runCallsiteGuard } from "./lib/callsite-guard.mjs";
import { runAsScript, toLine, unwrapExpression } from "./lib/ts-guard-utils.mjs";

const sourceRoots = ["src/gateway", "extensions/discord/src/voice"];
const enforcedFiles = new Set([
  "extensions/discord/src/voice/manager.ts",
  "src/gateway/openai-http.ts",
  "src/gateway/openresponses-http.ts",
  "src/gateway/server-methods/agent.ts",
  "src/gateway/server-node-events.ts",
]);

export function findLegacyAgentCommandCallLines(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const lines = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (ts.isIdentifier(callee) && callee.text === "agentCommand") {
        lines.push(toLine(sourceFile, callee));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return lines;
}

export async function main() {
  await runCallsiteGuard({
    importMetaUrl: import.meta.url,
    sourceRoots,
    findCallLines: findLegacyAgentCommandCallLines,
    skipRelativePath: (relPath) => !enforcedFiles.has(relPath.replaceAll(path.sep, "/")),
    header: "Found ingress callsites using local agentCommand() (must be explicit owner-aware):",
    footer:
      "Use agentCommandFromIngress(...) and pass senderIsOwner explicitly at ingress boundaries.",
  });
}

runAsScript(import.meta.url, main);
