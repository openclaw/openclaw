#!/usr/bin/env node

import ts from "typescript";
import { runCallsiteGuard } from "./lib/callsite-guard.mjs";
import { runAsScript, toLine, unwrapExpression } from "./lib/ts-guard-utils.mjs";

const sourceRoots = ["src", "extensions"];

// Temporary allowlist for legacy plugin entrypoints that still use the older
// registerHttpHandler API. New callsites should fail until migrated.
const allowedDeprecatedRegisterHttpHandlerCallsites = new Set([
  "extensions/bluebubbles/index.ts:15",
  "extensions/googlechat/index.ts:15",
  "extensions/nostr/index.ts:64",
  "extensions/zalo/index.ts:15",
]);

function isDeprecatedRegisterHttpHandlerCall(expression) {
  const callee = unwrapExpression(expression);
  return ts.isPropertyAccessExpression(callee) && callee.name.text === "registerHttpHandler";
}

export function findDeprecatedRegisterHttpHandlerLines(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const lines = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && isDeprecatedRegisterHttpHandlerCall(node.expression)) {
      lines.push(toLine(sourceFile, node.expression));
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
    findCallLines: findDeprecatedRegisterHttpHandlerLines,
    allowCallsite: (callsite) => allowedDeprecatedRegisterHttpHandlerCallsites.has(callsite),
    header: "Found deprecated plugin API call registerHttpHandler(...):",
    footer:
      "Use registerHttpRoute({ path, auth, match, handler }) and registerPluginHttpRoute for dynamic webhook paths.",
  });
}

runAsScript(import.meta.url, main);
