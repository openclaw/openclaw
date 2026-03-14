#!/usr/bin/env node

import ts from "typescript";
import { runCallsiteGuard } from "./lib/callsite-guard.mjs";
import { runAsScript, toLine, unwrapExpression } from "./lib/ts-guard-utils.mjs";

const sourceRoots = ["src/channels", "src/routing", "src/line", "extensions"];

// Temporary allowlist for legacy callsites. New raw fetch callsites in channel/plugin runtime
// code should be rejected and migrated to fetchWithSsrFGuard/shared channel helpers.
const allowedRawFetchCallsites = new Set([
  "extensions/bluebubbles/src/types.ts:133",
  "extensions/feishu/src/streaming-card.ts:31",
  "extensions/feishu/src/streaming-card.ts:101",
  "extensions/feishu/src/streaming-card.ts:143",
  "extensions/feishu/src/streaming-card.ts:199",
  "extensions/google-gemini-cli-auth/oauth.ts:372",
  "extensions/google-gemini-cli-auth/oauth.ts:408",
  "extensions/google-gemini-cli-auth/oauth.ts:447",
  "extensions/google-gemini-cli-auth/oauth.ts:507",
  "extensions/google-gemini-cli-auth/oauth.ts:575",
  "extensions/googlechat/src/api.ts:22",
  "extensions/googlechat/src/api.ts:43",
  "extensions/googlechat/src/api.ts:63",
  "extensions/googlechat/src/api.ts:188",
  "extensions/googlechat/src/auth.ts:82",
  "extensions/matrix/src/directory-live.ts:41",
  "extensions/matrix/src/matrix/client/config.ts:171",
  "extensions/mattermost/src/mattermost/client.ts:211",
  "extensions/mattermost/src/mattermost/monitor.ts:230",
  "extensions/mattermost/src/mattermost/probe.ts:27",
  "extensions/minimax-portal-auth/oauth.ts:71",
  "extensions/minimax-portal-auth/oauth.ts:112",
  "extensions/msteams/src/graph.ts:39",
  "extensions/nextcloud-talk/src/room-info.ts:92",
  "extensions/nextcloud-talk/src/send.ts:107",
  "extensions/nextcloud-talk/src/send.ts:198",
  "extensions/qwen-portal-auth/oauth.ts:46",
  "extensions/qwen-portal-auth/oauth.ts:80",
  "extensions/talk-voice/index.ts:27",
  "extensions/thread-ownership/index.ts:105",
  "extensions/voice-call/src/providers/plivo.ts:95",
  "extensions/voice-call/src/providers/telnyx.ts:61",
  "extensions/voice-call/src/providers/tts-openai.ts:111",
  "extensions/voice-call/src/providers/twilio/api.ts:23",
  "extensions/telegram/src/api-fetch.ts:8",
  "extensions/discord/src/send.outbound.ts:363",
  "extensions/discord/src/voice-message.ts:268",
  "extensions/discord/src/voice-message.ts:312",
  "extensions/slack/src/monitor/media.ts:55",
  "extensions/slack/src/monitor/media.ts:59",
  "extensions/slack/src/monitor/media.ts:73",
  "extensions/slack/src/monitor/media.ts:99",
]);

function isRawFetchCall(expression) {
  const callee = unwrapExpression(expression);
  if (ts.isIdentifier(callee)) {
    return callee.text === "fetch";
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return (
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "globalThis" &&
      callee.name.text === "fetch"
    );
  }
  return false;
}

export function findRawFetchCallLines(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const lines = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && isRawFetchCall(node.expression)) {
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
    extraTestSuffixes: [".browser.test.ts", ".node.test.ts"],
    findCallLines: findRawFetchCallLines,
    allowCallsite: (callsite) => allowedRawFetchCallsites.has(callsite),
    header: "Found raw fetch() usage in channel/plugin runtime sources outside allowlist:",
    footer: "Use fetchWithSsrFGuard() or existing channel/plugin SDK wrappers for network calls.",
  });
}

runAsScript(import.meta.url, main);
