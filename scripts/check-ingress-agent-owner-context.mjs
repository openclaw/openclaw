#!/usr/bin/env node

import path from "node:path";
import ts from "typescript";
import { runCallsiteGuard } from "./lib/callsite-guard.mjs";
import { runAsScript, toLine, unwrapExpression } from "./lib/ts-guard-utils.mjs";

const sourceRoots = ["src/gateway", "src/discord/voice"];
const enforcedFiles = new Set([
  "src/discord/voice/manager.ts",
  "src/gateway/openai-http.ts",
  "src/gateway/openresponses-http.ts",
  "src/gateway/server-methods/agent.ts",
  "src/gateway/server-node-events.ts",
]);

// Temporary allowlist for legacy ingress callsites. New agentCommand() use at
// ingress boundaries should fail until it is made owner-aware.
const allowedLegacyIngressCallsites = new Set([
  "src/discord/voice/manager.ts:631",
  "src/gateway/openai-http.ts:250",
  "src/gateway/openai-http.ts:330",
  "src/gateway/openresponses-http.ts:246",
  "src/gateway/server-methods/agent.ts:594",
  "src/gateway/server-node-events.ts:306",
  "src/gateway/server-node-events.ts:436",
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
    allowCallsite: (callsite) => allowedLegacyIngressCallsites.has(callsite),
    skipRelativePath: (relPath) => !enforcedFiles.has(relPath.replaceAll(path.sep, "/")),
    header: "Found ingress callsites using local agentCommand() (must be explicit owner-aware):",
    footer:
      "Use agentCommandFromIngress(...) and pass senderIsOwner explicitly at ingress boundaries.",
  });
}

runAsScript(import.meta.url, main);
