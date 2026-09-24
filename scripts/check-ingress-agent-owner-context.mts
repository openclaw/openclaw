#!/usr/bin/env node

// Ensures ingress agent command callsites pass explicit owner context.
import path from "node:path";
import * as ts from "typescript/unstable/ast";
import { bundledPluginFile } from "./lib/bundled-plugin-paths.mjs";
import { runCallsiteGuard } from "./lib/callsite-guard.mts";
import {
  collectCallExpressionLines,
  runAsScript,
  unwrapExpression,
} from "./lib/ts-guard-utils.mts";

const sourceRoots = ["src/gateway", bundledPluginFile("discord", "src/voice")];
const enforcedFiles = new Set([
  bundledPluginFile("discord", "src/voice/manager.ts"),
  "src/gateway/openai-http.ts",
  "src/gateway/openresponses-http.ts",
  "src/gateway/server-methods/agent.ts",
  "src/gateway/server-node-events.ts",
]);

/**
 * Finds legacy `agentCommand(...)` call lines in ingress-owned source.
 */
function findLegacyAgentCommandCallLines(
  _content: string,
  _fileName: string,
  sourceFile: ts.SourceFile,
) {
  return collectCallExpressionLines(sourceFile, (node) => {
    const callee = unwrapExpression(node.expression);
    return ts.isIdentifier(callee) && callee.text === "agentCommand" ? callee : null;
  });
}

/**
 * Runs the ingress owner-context guard.
 */
async function main() {
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
