#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const distRoots = [
  "/app/dist",
  "/home/node/.openclaw/extensions/whatsapp/node_modules/openclaw/dist",
  "/home/node/.openclaw/npm/node_modules/@openclaw/codex/node_modules/openclaw/dist",
  "/home/node/.openclaw/npm/node_modules/@openclaw/acpx/node_modules/openclaw/dist",
  "/home/node/.openclaw/npm/node_modules/@openclaw/memory-lancedb/node_modules/openclaw/dist",
  "/home/node/.openclaw/npm/node_modules/@openclaw/brave-plugin/node_modules/openclaw/dist",
];

function listJs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(root, name));
}

function findBundle(root, predicate) {
  for (const file of listJs(root)) {
    const text = fs.readFileSync(file, "utf8");
    if (predicate(text, file)) return { file, text };
  }
  return null;
}

function findLiveProjectorImportSpecifier(root) {
  const target = findBundle(root, (text) =>
    text.includes("projectLiveAssistantBufferedText as n") &&
    text.includes("function projectLiveAssistantBufferedText")
  );
  return target ? `./${path.basename(target.file)}` : "";
}

function replaceOnce(text, needle, replacement, label) {
  if (!text.includes(needle)) {
    throw new Error(`missing patch anchor: ${label}`);
  }
  return text.replace(needle, replacement);
}

function replaceRegexOnce(text, regex, replacement, label) {
  if (!regex.test(text)) {
    throw new Error(`missing patch anchor: ${label}`);
  }
  return text.replace(regex, replacement);
}

function writeIfChanged(file, before, after) {
  if (before === after) return false;
  fs.writeFileSync(file, after);
  return true;
}

function patchControlReply(root) {
  const target = findBundle(root, (text) =>
    text.includes("SUPPRESSED_CONTROL_REPLY_TOKENS") &&
    text.includes("isSuppressedControlReplyText") &&
    text.includes("isSuppressedControlReplyLeadFragment")
  );
  if (!target) return "missing";
  let { file, text } = target;
  const before = text;

  if (!text.includes("SUPPRESSED_CONTROL_REPLY_PHRASES")) {
    text = replaceOnce(
      text,
      `const MIN_BARE_PREFIX_LENGTH_BY_TOKEN = {`,
      `const SUPPRESSED_CONTROL_REPLY_PHRASES = [
\t"Visible reply sent.",
\t"Visible reply sent"
];
const MIN_BARE_PREFIX_LENGTH_BY_TOKEN = {`,
      "control phrases"
    );
    text = replaceOnce(
      text,
      `function normalizeSuppressedControlReplyFragment(text) {`,
      `function isSuppressedControlReplyPhrase(text) {
\tconst normalized = text.trim().toLowerCase();
\treturn SUPPRESSED_CONTROL_REPLY_PHRASES.some((phrase) => normalized === phrase.toLowerCase());
}
function isSuppressedControlReplyPhraseLeadFragment(text) {
\tconst normalized = text.trim().toLowerCase();
\tif (normalized.length < 3) return false;
\treturn SUPPRESSED_CONTROL_REPLY_PHRASES.some((phrase) => phrase.toLowerCase().startsWith(normalized));
}
function normalizeSuppressedControlReplyFragment(text) {`,
      "control phrase helpers"
    );
    text = replaceOnce(
      text,
      `return SUPPRESSED_CONTROL_REPLY_TOKENS.some((token) => isSilentReplyText(normalized, token));`,
      `return isSuppressedControlReplyPhrase(normalized) || SUPPRESSED_CONTROL_REPLY_TOKENS.some((token) => isSilentReplyText(normalized, token));`,
      "control text suppression"
    );
    text = replaceOnce(
      text,
      `const trimmed = text.trim();
\tconst normalized = normalizeSuppressedControlReplyFragment(text);`,
      `const trimmed = text.trim();
\tif (isSuppressedControlReplyPhraseLeadFragment(trimmed)) return true;
\tconst normalized = normalizeSuppressedControlReplyFragment(text);`,
      "control lead suppression"
    );
  }

  return writeIfChanged(file, before, text) ? `patched ${file}` : `already patched ${file}`;
}

function patchChatDisplayProjection(root) {
  const target = findBundle(root, (text) =>
    text.includes("function mirrorMessageToolVisibleReplies(messages)") &&
    text.includes("function extractMessageToolVisibleReplies")
  );
  if (!target) return "missing";
  let { file, text } = target;
  const before = text;

  if (!text.includes("hasSucceededPendingMirror")) {
    text = replaceOnce(
      text,
      `\tconst flushSucceededMirrors = () => {
\t\tfor (const item of pending) {
\t\t\tif (!item.succeeded) continue;
\t\t\tnext.push(buildMessageToolVisibleReplyMirror(item));
\t\t\tchanged = true;
\t\t}
\t\tclearPending();
\t};`,
      `\tconst flushSucceededMirrors = () => {
\t\tfor (const item of pending) {
\t\t\tif (!item.succeeded) continue;
\t\t\tnext.push(buildMessageToolVisibleReplyMirror(item));
\t\t\tchanged = true;
\t\t}
\t\tclearPending();
\t};
\tconst hasSucceededPendingMirror = () => pending.some((item) => item.succeeded);`,
      "message mirror helper"
    );
    text = replaceOnce(
      text,
      `\t\tconst visibleReplies = extractMessageToolVisibleReplies(record);
\t\tif (visibleReplies.length > 0) for (const reply of visibleReplies) pending.push({
\t\t\t...reply,
\t\t\tanchor: record,
\t\t\tsucceeded: false
\t\t});
\t\telse if (isRenderableAssistantDisplayMessage(record)) clearPending();
\t\tif (pending.length > 0) {
\t\t\tfor (const item of pending) if (!item.succeeded && isSuccessfulMessageToolResult(record, item)) {
\t\t\t\titem.succeeded = true;
\t\t\t\titem.completionAnchor = record;
\t\t\t}
\t\t\tif (isAssistantSilentControlReplyOnly(record)) flushSucceededMirrors();
\t\t}
\t\tnext.push(message);`,
      `\t\tconst visibleReplies = extractMessageToolVisibleReplies(record);
\t\tif (visibleReplies.length > 0) for (const reply of visibleReplies) pending.push({
\t\t\t...reply,
\t\t\tanchor: record,
\t\t\tsucceeded: false
\t\t});
\t\tif (pending.length > 0) {
\t\t\tfor (const item of pending) if (!item.succeeded && isSuccessfulMessageToolResult(record, item)) {
\t\t\t\titem.succeeded = true;
\t\t\t\titem.completionAnchor = record;
\t\t\t}
\t\t\tif (isAssistantSilentControlReplyOnly(record)) flushSucceededMirrors();
\t\t\telse if (isRenderableAssistantDisplayMessage(record)) {
\t\t\t\tif (hasSucceededPendingMirror()) {
\t\t\t\t\tflushSucceededMirrors();
\t\t\t\t\tchanged = true;
\t\t\t\t\tcontinue;
\t\t\t\t}
\t\t\t\tclearPending();
\t\t\t}
\t\t}
\t\tnext.push(message);`,
      "message mirror final-summary drop"
    );
  }

  return writeIfChanged(file, before, text) ? `patched ${file}` : `already patched ${file}`;
}

function patchTui(root) {
  const target = findBundle(root, (text, file) =>
    /\/tui-[^/]+\.js$/.test(file) &&
    text.includes("function createEventHandlers(context)") &&
    (
      text.includes("chatLog.updateAssistant(displayText, evt.runId);") ||
      text.includes("pendingVisibleMessageRepliesByRun") ||
      text.includes("projectLiveAssistantBufferedText(displayText")
    )
  );
  if (!target) return "missing";
  let { file, text } = target;
  const before = text;

  if (!text.includes("projectLiveAssistantBufferedText")) {
    const liveProjectorSpecifier = findLiveProjectorImportSpecifier(root);
    if (!liveProjectorSpecifier) {
      throw new Error(`missing live chat projector bundle in ${root}`);
    }
    text = replaceRegexOnce(
      text,
      /import \{ s as setConsoleSubsystemFilter \} from "\.\/console-[^"]+\.js";/,
      (match) => `${match}
import { n as projectLiveAssistantBufferedText } from "${liveProjectorSpecifier}";`,
      "live projector import"
    );
  }

  if (!text.includes("isVisibleReplyControlAcknowledgementText")) {
    text = replaceOnce(
      text,
      `function isCommandMessage(message) {
\tif (!message || typeof message !== "object") return false;
\treturn message.command === true;
}
function formatTokens(total, context) {`,
      `function isCommandMessage(message) {
\tif (!message || typeof message !== "object") return false;
\treturn message.command === true;
}
function isVisibleReplyControlAcknowledgementText(text) {
\treturn /^\\s*(?:NO_REPLY|Visible reply sent\\.?)\\s*$/i.test(text);
}
function isControlAcknowledgementMessage(message) {
\tconst record = asMessageRecord(message);
\tif (!record || record.role !== "assistant") return false;
\tconst text = extractTextFromMessage(record).trim();
\tif (!isVisibleReplyControlAcknowledgementText(text)) return false;
\tif (typeof record.mediaUrl === "string" && record.mediaUrl.trim()) return false;
\tif (Array.isArray(record.mediaUrls) && record.mediaUrls.some((media) => typeof media === "string" && media.trim())) return false;
\tif (!Array.isArray(record.content)) return true;
\treturn record.content.every((block) => {
\t\tif (!block || typeof block !== "object") return true;
\t\tconst type = block.type;
\t\treturn type === "text" || type === "thinking";
\t});
}
function hasNonEmptyMessageToolArgValue(value) {
\tif (typeof value === "string") return value.trim().length > 0;
\tif (Array.isArray(value)) return value.some(hasNonEmptyMessageToolArgValue);
\tif (!value || typeof value !== "object") return value != null;
\treturn Object.values(value).some(hasNonEmptyMessageToolArgValue);
}
function hasExplicitMessageToolReplyRoute(args) {
\treturn [
\t\t"target",
\t\t"targets",
\t\t"to",
\t\t"recipient",
\t\t"recipients",
\t\t"chatId",
\t\t"chat_id",
\t\t"channelId",
\t\t"channel_id",
\t\t"conversationId",
\t\t"conversation_id",
\t\t"threadId",
\t\t"thread_id",
\t\t"roomId",
\t\t"room_id",
\t\t"groupId",
\t\t"group_id"
\t].some((field) => hasNonEmptyMessageToolArgValue(args[field]));
}
function isDryRunMessageToolArgs(args) {
\tif (args.dryRun === true || args.dry_run === true) return true;
\tconst status = asString(args.deliveryStatus ?? args.delivery_status ?? args.status, "").trim().toLowerCase();
\treturn status === "dry_run";
}
function readMessageToolReplyText(args) {
\tfor (const field of [
\t\t"message",
\t\t"text",
\t\t"content",
\t\t"body",
\t\t"caption"
\t]) {
\t\tconst value = args[field];
\t\tif (typeof value === "string" && value.trim()) return value;
\t}
\treturn "";
}
function readVisibleMessageToolReplyFromArgs(args) {
\tconst record = asMessageRecord(args);
\tif (!record) return "";
\tif (asString(record.action, "").trim().toLowerCase() !== "send") return "";
\tif (isDryRunMessageToolArgs(record)) return "";
\tif (hasExplicitMessageToolReplyRoute(record)) return "";
\treturn readMessageToolReplyText(record);
}
function formatTokens(total, context) {`,
      "tui control/message helpers"
    );
  }

  if (!text.includes("pendingVisibleMessageRepliesByRun")) {
    text = replaceOnce(
      text,
      `\tconst postFinalizingRuns = /* @__PURE__ */ new Map();
\tlet streamAssembler = new TuiStreamAssembler();`,
      `\tconst postFinalizingRuns = /* @__PURE__ */ new Map();
\tconst pendingVisibleMessageRepliesByRun = /* @__PURE__ */ new Map();
\tlet streamAssembler = new TuiStreamAssembler();`,
      "pending message map"
    );
    text = replaceOnce(
      text,
      `\t\tpostFinalizingRuns.clear();
\t\tstreamAssembler = new TuiStreamAssembler();`,
      `\t\tpostFinalizingRuns.clear();
\t\tpendingVisibleMessageRepliesByRun.clear();
\t\tstreamAssembler = new TuiStreamAssembler();`,
      "session reset pending message map"
    );
    text = replaceOnce(
      text,
      `\t\tsessionRuns.delete(runId);
\t\tstreamAssembler.drop(runId);`,
      `\t\tsessionRuns.delete(runId);
\t\tpendingVisibleMessageRepliesByRun.delete(runId);
\t\tstreamAssembler.drop(runId);`,
      "finalized pending cleanup"
    );
    text = replaceOnce(
      text,
      `\t\tstreamAssembler.drop(params.runId);
\t\tsessionRuns.delete(params.runId);
\t\tclearActiveRunIfMatch(params.runId);`,
      `\t\tstreamAssembler.drop(params.runId);
\t\tsessionRuns.delete(params.runId);
\t\tpendingVisibleMessageRepliesByRun.delete(params.runId);
\t\tclearActiveRunIfMatch(params.runId);`,
      "terminated pending cleanup"
    );
    text = replaceOnce(
      text,
      `\t\tpendingHistoryRefresh = false;
\t\tloadHistory?.();
\t};
\tconst messageHasDisplayableNonTextContent = (message) => {`,
      `\t\tpendingHistoryRefresh = false;
\t\tloadHistory?.();
\t};
\tconst rememberVisibleMessageToolReply = (runId, toolCallId, args) => {
\t\tconst text = readVisibleMessageToolReplyFromArgs(args);
\t\tif (!text.trim()) return;
\t\tconst items = pendingVisibleMessageRepliesByRun.get(runId) ?? [];
\t\titems.push({
\t\t\ttoolCallId,
\t\t\ttext,
\t\t\tsucceeded: false
\t\t});
\t\tpendingVisibleMessageRepliesByRun.set(runId, items);
\t};
\tconst markVisibleMessageToolReplyResult = (runId, toolCallId, isError) => {
\t\tconst items = pendingVisibleMessageRepliesByRun.get(runId);
\t\tif (!items) return;
\t\tfor (const item of items) if (item.toolCallId === toolCallId) {
\t\t\titem.succeeded = !isError;
\t\t\tbreak;
\t\t}
\t};
\tconst takeSucceededVisibleMessageToolReply = (runId) => {
\t\tconst items = pendingVisibleMessageRepliesByRun.get(runId);
\t\tif (!items) return "";
\t\tconst item = items.find((candidate) => candidate.succeeded && candidate.text.trim());
\t\tpendingVisibleMessageRepliesByRun.delete(runId);
\t\treturn item?.text ?? "";
\t};
\tconst hasSucceededVisibleMessageToolReply = (runId) => {
\t\tconst items = pendingVisibleMessageRepliesByRun.get(runId);
\t\treturn Boolean(items?.some((candidate) => candidate.succeeded && candidate.text.trim()));
\t};
\tconst messageHasDisplayableNonTextContent = (message) => {`,
      "pending message helpers"
    );
  }

  if (!text.includes("isControlAcknowledgementMessage(evt.message)")) {
    text = replaceOnce(
      text,
      `\t\tif (!evt.message) return false;
\t\tif (extractTextFromMessage(evt.message, { includeThinking: state.showThinking }).trim()) return true;`,
      `\t\tif (!evt.message) return false;
\t\tif (isControlAcknowledgementMessage(evt.message)) return false;
\t\tif (extractTextFromMessage(evt.message, { includeThinking: state.showThinking }).trim()) return true;`,
      "control acknowledgement final display check"
    );
  }

  if (!text.includes("projectLiveAssistantBufferedText(displayText")) {
    text = replaceOnce(
      text,
      `\t\tif (evt.state === "delta") {
\t\t\tsetActivityStatus("streaming");
\t\t\tif (state.activeChatRunId === evt.runId) armStreamingWatchdog(evt.runId);
\t\t\tconst displayText = streamAssembler.ingestDelta(evt.runId, evt.message, state.showThinking);
\t\t\tif (!displayText) return;
\t\t\tchatLog.updateAssistant(displayText, evt.runId);
\t\t}`,
      `\t\tif (evt.state === "delta") {
\t\t\tsetActivityStatus("streaming");
\t\t\tif (state.activeChatRunId === evt.runId) armStreamingWatchdog(evt.runId);
\t\t\tconst displayText = streamAssembler.ingestDelta(evt.runId, evt.message, state.showThinking);
\t\t\tif (!displayText) return;
\t\t\tif (hasSucceededVisibleMessageToolReply(evt.runId)) {
\t\t\t\tchatLog.dropAssistant(evt.runId);
\t\t\t\treturn;
\t\t\t}
\t\t\tconst projected = projectLiveAssistantBufferedText(displayText, { suppressLeadFragments: true });
\t\t\tif (projected.suppress) {
\t\t\t\tchatLog.dropAssistant(evt.runId);
\t\t\t\treturn;
\t\t\t}
\t\t\tchatLog.updateAssistant(projected.text, evt.runId);
\t\t}`,
      "delta live projection"
    );
  }

  if (!text.includes("const visibleMessageToolReplyText = takeSucceededVisibleMessageToolReply")) {
    text = replaceOnce(
      text,
      `\t\tif (evt.state === "final") {
\t\t\tconst isLocalBtwRun = isLocalBtwRunId?.(evt.runId) ?? false;
\t\t\tconst wasActiveRun = state.activeChatRunId === evt.runId;
\t\t\tif (!evt.message && isLocalBtwRun) {`,
      `\t\tif (evt.state === "final") {
\t\t\tconst isLocalBtwRun = isLocalBtwRunId?.(evt.runId) ?? false;
\t\t\tconst wasActiveRun = state.activeChatRunId === evt.runId;
\t\t\tconst visibleMessageToolReplyText = takeSucceededVisibleMessageToolReply(evt.runId);
\t\t\tif (visibleMessageToolReplyText.trim()) {
\t\t\t\tchatLog.finalizeAssistant(visibleMessageToolReplyText, evt.runId);
\t\t\t\tfinalizeRun({
\t\t\t\t\trunId: evt.runId,
\t\t\t\t\twasActiveRun,
\t\t\t\t\tstatus: "idle",
\t\t\t\t\tdisplayedFinal: true
\t\t\t\t});
\t\t\t\ttui.requestRender();
\t\t\t\treturn;
\t\t\t}
\t\t\tif (!evt.message && isLocalBtwRun) {`,
      "final message tool payload preference"
    );
  }

  if (!text.includes("rememberVisibleMessageToolReply(evt.runId")) {
    text = replaceOnce(
      text,
      `\t\tif (evt.stream === "tool") {
\t\t\tif (isActiveRun) armStreamingWatchdog(evt.runId);
\t\t\tconst verbose = state.sessionInfo.verboseLevel ?? "off";
\t\t\tconst allowToolEvents = verbose !== "off";
\t\t\tconst allowToolOutput = verbose === "full";
\t\t\tif (!allowToolEvents) return;
\t\t\tconst data = evt.data ?? {};
\t\t\tconst phase = asString(data.phase, "");
\t\t\tconst toolCallId = asString(data.toolCallId, "");
\t\t\tconst toolName = asString(data.name, "tool");`,
      `\t\tif (evt.stream === "tool") {
\t\t\tif (isActiveRun) armStreamingWatchdog(evt.runId);
\t\t\tconst data = evt.data ?? {};
\t\t\tconst phase = asString(data.phase, "");
\t\t\tconst toolCallId = asString(data.toolCallId, "");
\t\t\tconst toolName = asString(data.name, "tool");
\t\t\tif (toolCallId && toolName.toLowerCase() === "message") {
\t\t\t\tif (phase === "start") rememberVisibleMessageToolReply(evt.runId, toolCallId, data.args);
\t\t\t\telse if (phase === "result") markVisibleMessageToolReplyResult(evt.runId, toolCallId, Boolean(data.isError));
\t\t\t}
\t\t\tconst verbose = state.sessionInfo.verboseLevel ?? "off";
\t\t\tconst allowToolEvents = verbose !== "off";
\t\t\tconst allowToolOutput = verbose === "full";
\t\t\tif (!allowToolEvents) return;`,
      "message tool event tracking"
    );
  }

  return writeIfChanged(file, before, text) ? `patched ${file}` : `already patched ${file}`;
}

const summaries = [];
let patchedRoots = 0;
for (const root of distRoots) {
  if (!fs.existsSync(root)) continue;
  const results = [
    patchControlReply(root),
    patchChatDisplayProjection(root),
    patchTui(root),
  ];
  if (results.some((result) => result !== "missing")) patchedRoots += 1;
  summaries.push({ root, results });
}

if (patchedRoots === 0) {
  throw new Error("no OpenClaw dist roots found to patch");
}

for (const { root, results } of summaries) {
  if (results.every((result) => result === "missing")) continue;
  console.log(`[openclaw-local-webchat-message-delivery] ${root}`);
  for (const result of results) console.log(`  - ${result}`);
}
