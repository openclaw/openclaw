#!/usr/bin/env node

import path from "node:path";
import ts from "typescript";
import { runCallsiteGuard } from "./lib/callsite-guard.mjs";
import {
  collectCallExpressionLines,
  runAsScript,
  unwrapExpression,
} from "./lib/ts-guard-utils.mjs";

const sourceRoots = ["src", "extensions"];
const allowedRawHttp2ConnectCallsites = new Set([
  "src/infra/push-apns-http2.ts:39",
  "src/infra/push-apns-http2.ts:55",
]);

function isHttp2ConnectCall(expression) {
  const callee = unwrapExpression(expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "connect") {
    return false;
  }
  const receiver = unwrapExpression(callee.expression);
  return ts.isIdentifier(receiver) && receiver.text === "http2";
}

export function findRawHttp2ConnectCallLines(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  return collectCallExpressionLines(ts, sourceFile, (node) =>
    isHttp2ConnectCall(node.expression) ? node.expression : null,
  );
}

export async function main() {
  await runCallsiteGuard({
    importMetaUrl: import.meta.url,
    sourceRoots,
    extraTestSuffixes: [".browser.test.ts", ".node.test.ts"],
    findCallLines: findRawHttp2ConnectCallLines,
    allowCallsite: (callsite) => allowedRawHttp2ConnectCallsites.has(callsite),
    skipRelativePath: (relPath) =>
      relPath === path.posix.join("src", "infra", "push-apns-http2.test.ts"),
    header: "Found raw http2.connect usage outside APNs proxy wrapper:",
    footer:
      "Use connectApnsHttp2Session() from src/infra/push-apns-http2.ts so APNs HTTP/2 honors managed proxy policy.",
  });
}

runAsScript(import.meta.url, main);
