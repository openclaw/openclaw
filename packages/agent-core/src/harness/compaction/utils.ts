import {
  hasRuntimeContextMarker,
  type AssistantMessage,
  type Message,
  type ToolCall,
} from "@openclaw/llm-core";
import { estimateStringChars } from "@openclaw/normalization-core/cjk-chars";
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { AgentMessage } from "../../types.js";
import { createToolCallOccurrenceQueue } from "../session/tool-result-pairing.js";
import type { FileOperations } from "../types.js";
import { copyString } from "../utils/truncate.js";
import {
  ELISION_MARKER_RESERVE_CHARS,
  ENTRY_SEPARATOR,
  renderConversationEntriesWithinBudget,
  type BoundedConversation,
  type ConversationEntryDescriptor,
  type ConversationEntryText,
  type ConversationTextVariant,
} from "./conversation-serialization.js";

export {
  MAX_SUMMARY_INPUT_CHARS,
  renderConversationEntriesWithinBudget,
  type BoundedConversation,
  type ConversationEntryDescriptor,
  type ConversationTextVariant,
} from "./conversation-serialization.js";

export type { FileOperations } from "../types.js";

function normalizeFileToolName(value: string): string {
  const name = value.toLowerCase();
  const separator = name.indexOf("__", name.startsWith("mcp__") ? 5 : 0);
  return separator < 0 ? name : name.slice(separator + 2);
}

function addFilePaths(target: Set<string>, value: unknown): void {
  for (const path of Array.isArray(value) ? value : []) {
    if (typeof path === "string") {
      target.add(path);
    }
  }
}

/** Create an empty file-operation accumulator. */
export function createFileOps(): FileOperations {
  return { read: new Set(), written: new Set(), edited: new Set() };
}

/** Restore file metadata recorded by an earlier compaction or branch summary. */
export function mergeSummaryFileOperations(
  fileOps: FileOperations,
  details: { readFiles: string[]; modifiedFiles: string[] },
): void {
  addFilePaths(fileOps.read, details.readFiles);
  addFilePaths(fileOps.edited, details.modifiedFiles);
}

/** Pair outcomes within each tool turn before collecting conservative file metadata. */
export function extractFileOpsFromMessages(
  messages: readonly AgentMessage[],
  fileOps: FileOperations,
): void {
  const calls = createToolCallOccurrenceQueue<{ call: ToolCall; name: string }>();
  const unchanged = new Set<ToolCall>();
  for (const message of messages) {
    if (message.role === "assistant") {
      calls.clear();
      for (const call of message.content) {
        if (call.type === "toolCall") {
          calls.add(call.id, { call, name: normalizeFileToolName(call.name) });
        }
      }
    } else if (message.role === "toolResult") {
      const occurrence = calls.claim(message.toolCallId);
      const name = normalizeFileToolName(message.toolName);
      if (
        occurrence?.name === name &&
        (name === "edit" || name === "write") &&
        asRecord(message.details)?.changed === false
      ) {
        unchanged.add(occurrence.call);
      }
    } else {
      calls.clear();
    }
  }
  for (const message of messages) {
    extractFileOpsFromMessage(message, fileOps, unchanged);
  }
}

function extractFileOpsFromMessage(
  message: AgentMessage,
  fileOps: FileOperations,
  unchanged: ReadonlySet<ToolCall>,
): void {
  if (message.role === "toolResult") {
    if (normalizeFileToolName(message.toolName) !== "apply_patch") {
      return;
    }
    for (const result of [message, ...(Array.isArray(message.content) ? message.content : [])]) {
      const details = asRecord(asRecord(result)?.details);
      const summary = asRecord(details?.summary);
      addFilePaths(fileOps.written, summary?.added);
      addFilePaths(fileOps.edited, summary?.modified);
    }
    // Deleted paths no longer exist for a continuation to inspect, so omit them.
    return;
  }

  if (message.role !== "assistant") {
    return;
  }
  for (const toolCall of message.content) {
    if (toolCall.type !== "toolCall" || unchanged.has(toolCall)) {
      continue;
    }
    const args = asRecord(toolCall.arguments);
    const path = [args?.path, args?.file_path, args?.filePath].find(
      (value): value is string => typeof value === "string",
    );
    if (!path) {
      continue;
    }
    switch (normalizeFileToolName(toolCall.name)) {
      case "read":
        fileOps.read.add(path);
        break;
      case "write":
        fileOps.written.add(path);
        break;
      case "edit":
        fileOps.edited.add(path);
        break;
    }
  }
}

/** Compute sorted read-only and modified file lists from accumulated operations. */
export function computeFileLists(fileOps: FileOperations): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).toSorted();
  const modifiedFiles = [...modified].toSorted();
  return { readFiles: readOnly, modifiedFiles };
}

// File lists ratchet across compactions (prior summary entries merge into the
// next accumulation), so an unbounded join grows without limit in long
// sessions. Hard caps keep the model-visible section bounded per the
// context-budget invariant; overflow collapses to a "...and N more" line.
const MAX_FILE_OPS_LIST_CHARS = 900;

function formatBoundedFileList(tag: string, files: string[], maxChars: number): string {
  if (files.length === 0 || maxChars <= 0) {
    return "";
  }
  const openTag = `<${tag}>\n`;
  const closeTag = `\n</${tag}>`;
  const lines: string[] = [];
  let usedChars = openTag.length + closeTag.length;

  for (let i = 0; i < files.length; i++) {
    const line = `${files[i]}\n`;
    const remaining = files.length - i - 1;
    const overflowLine = remaining > 0 ? `...and ${remaining} more\n` : "";
    const projected = usedChars + line.length + overflowLine.length;
    if (projected > maxChars) {
      const overflow = `...and ${files.length - i} more\n`;
      if (usedChars + overflow.length <= maxChars) {
        lines.push(overflow);
      }
      break;
    }
    lines.push(line);
    usedChars += line.length;
  }

  return lines.length > 0 ? `${openTag}${lines.join("").trimEnd()}${closeTag}` : "";
}

/** Format file lists as bounded summary metadata tags. */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections = [
    formatBoundedFileList("read-files", readFiles, MAX_FILE_OPS_LIST_CHARS),
    formatBoundedFileList("modified-files", modifiedFiles, MAX_FILE_OPS_LIST_CHARS),
  ].filter(Boolean);
  // Both 900-character lists and their separators fit the 2,000-character section cap.
  return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

/** Extract visible summary text without normalizing valid model output. */
export function extractSummaryText(response: AssistantMessage): string | undefined {
  const summary = response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return summary.trim() ? summary : undefined;
}

const TOOL_RESULT_MAX_CHARS = 2000;
// Tool output fills most of a long history; when the summary input is sampled,
// results older than the newest entries keep this much of their head and tail.
const SAMPLED_TOOL_RESULT_MAX_CHARS = 500;
const IMPORTANT_TOOL_RESULT_TAIL =
  /(error|exception|failed|fatal|traceback|panic|stack trace|errno|exit code)/i;

export function stringifyCompactionValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const tailChars = Math.min(Math.floor(maxChars * 0.3), 600);
  const diagnosticSearch = sliceUtf16Safe(text, -maxChars);
  const diagnosticMatches = [
    ...diagnosticSearch.matchAll(new RegExp(IMPORTANT_TOOL_RESULT_TAIL.source, "gi")),
  ];
  const diagnosticMatch =
    diagnosticMatches.findLast((match) =>
      /^(error|exception|fatal|panic|errno)$/i.test(match[0]),
    ) ?? diagnosticMatches.at(-1);
  if (diagnosticMatch) {
    const head = truncateUtf16Safe(text, maxChars - tailChars);
    const displacedHead = sliceUtf16Safe(text, Math.max(0, head.length - 32), maxChars);
    // A routine footer can match failure words. Never shorten the original
    // retained head when doing so would discard an existing diagnostic.
    if (!IMPORTANT_TOOL_RESULT_TAIL.test(displacedHead)) {
      const diagnosticOffset = text.length - diagnosticSearch.length + (diagnosticMatch.index ?? 0);
      const tailStart = Math.min(diagnosticOffset, text.length - tailChars);
      // An early diagnostic already lives in the retained prefix; reusing it
      // as a tail would overlap the head and miscount omitted characters.
      if (tailStart >= head.length) {
        const tail = sliceUtf16Safe(text, tailStart, tailStart + tailChars);
        const truncatedChars = text.length - head.length - tail.length;
        const omissionPosition = tailStart + tail.length < text.length ? "middle/trailing" : "more";
        // Commands usually report their actual failure last; preserve that tail
        // so branch and ordinary compaction summaries can explain what failed.
        return `${head}\n\n[... ${truncatedChars} ${omissionPosition} characters truncated]\n\n${tail}`;
      }
    }
  }
  const headBudget = maxChars - tailChars - ELISION_MARKER_RESERVE_CHARS;
  const prefix = truncateUtf16Safe(text, maxChars);
  // Preserve diagnostics the old prefix already held; ordinary results also
  // need their terminal facts, with the marker inside the same budget.
  const tail = IMPORTANT_TOOL_RESULT_TAIL.test(prefix) ? "" : sliceUtf16Safe(text, -tailChars);
  const head = tail ? truncateUtf16Safe(prefix, headBudget) : prefix;
  const truncatedChars = text.length - head.length - tail.length;
  return `${head}\n\n[... ${truncatedChars} more characters truncated]${tail ? `\n\n${tail}` : ""}`;
}

/** Project summary content once so rendering and token accounting share omission facts. */
export function getCompactionContent(
  content: string | Array<{ type: string; content?: unknown; text?: string }>,
): { text: string; omissionText: string } {
  const omissions = new Set<string>();
  const text =
    typeof content === "string"
      ? content
      : content
          .map((block) => {
            let blockText = "";
            if (
              (block.type === "text" ||
                block.type === "toolResult" ||
                block.type === "tool_result") &&
              block.text
            ) {
              blockText = block.text;
            } else if (
              (block.type === "toolResult" || block.type === "tool_result") &&
              typeof block.content === "string"
            ) {
              blockText = block.content;
            }
            if (block.type !== "text" && !blockText) {
              // This projection knows only what it omits, not whether a model processed it.
              omissions.add(
                block.type === "image"
                  ? "[image data omitted from summary input]"
                  : "[non-text data omitted from summary input]",
              );
            }
            return blockText;
          })
          .filter(Boolean)
          .join("\n");
  return { text, omissionText: [...omissions].join("\n") };
}

const MAX_OMISSION_MESSAGES = 8;
const OMISSION_OVERFLOW = "[More image/non-text data omitted from summary input]";

// Compaction sees both model messages and harness-only AgentMessages. Sender
// metadata is only meaningful on user turns, so this deliberately accepts the
// minimal shared shape rather than forcing token accounting through an unsafe
// Message cast.
type PersistedSenderCarrier = { role: string };

/**
 * Return exactly the persisted-sender text which is projected into a user
 * conversation label. Keep this shared with token accounting: adding a label
 * to the prompt without charging it can make bounded compaction overflow.
 */
function formatPersistedSenderSuffix(message: PersistedSenderCarrier): string {
  if (message.role !== "user") {
    return "";
  }
  const metadata = asRecord(Reflect.get(message, "__openclaw"));
  if (!metadata) {
    return "";
  }
  const normalize = (value: unknown): string | undefined => {
    if (typeof value !== "string") {
      return undefined;
    }
    const normalized = value.replaceAll("\u0000", "").trim();
    return normalized || undefined;
  };
  const sender = {
    id: normalize(metadata.senderId),
    name: normalize(metadata.senderName),
    username: normalize(metadata.senderUsername),
  };
  // Display names and usernames are mutable and non-unique. They are useful
  // labels only once a stable sender ID anchors them; on their own they must
  // not turn a legacy/partial record into asserted author provenance.
  return sender.id ? ` sender=${JSON.stringify(sender)}` : "";
}

function compactionUserRole(message: PersistedSenderCarrier): string {
  if (hasRuntimeContextMarker(message)) {
    return "Runtime context";
  }
  if (Reflect.get(message, "synthetic") === true) {
    return "Synthetic input";
  }
  if (Reflect.get(message, "operatorMessage") !== undefined) {
    return "Operator input";
  }
  const metadata = asRecord(Reflect.get(message, "__openclaw"));
  if (metadata?.beforeAgentRunBlocked !== undefined) {
    return "Internal system input";
  }
  const rawProvenance = Reflect.get(message, "provenance");
  // Unmarked external turns are a shipped transcript contract. An explicit
  // unrecognized record must not acquire that legacy meaning by normalization.
  if (rawProvenance === undefined) {
    return "User";
  }
  const provenance = asRecord(rawProvenance);
  switch (provenance?.kind) {
    case "external_user":
      return "User";
    case "realtime_voice":
      // Talk persists actual spoken user text outside the foreground turn.
      return provenance.sourceChannel === "talk" ? "User" : "Unknown-origin input";
    case "inter_session":
      return "Inter-session input";
    case "internal_system":
      return "Internal system input";
    default:
      return "Unknown-origin input";
  }
}

/** Compaction request attribution only; admitted internal inputs still start runtime turns. */
function isCompactionUserRequest(message: PersistedSenderCarrier): boolean {
  return message.role === "user" && compactionUserRole(message) === "User";
}

/** Callers retain their text projection; request attribution has one owner. */
export function findLatestCompactionUserMessage(
  messages: readonly AgentMessage[],
  getText: (message: Extract<AgentMessage, { role: "user" }>) => string,
): Extract<AgentMessage, { role: "user" }> | undefined {
  return messages.findLast(
    (message): message is Extract<AgentMessage, { role: "user" }> =>
      message.role === "user" &&
      isCompactionUserRequest(message) &&
      Boolean(getText(message).trim()),
  );
}

const CREDENTIAL_PATTERNS = [
  /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|github_pat|xox[abprs]|glpat|AKIA|AIza)[-_A-Za-z0-9]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /\b(?:api[_-]?key|token|secret|password|passwd|authorization|bearer)\b\s*[:=]\s*["']?[^\s"']{8,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/**
 * Text quoted verbatim into compaction artifacts. Summaries are persisted and replayed
 * on every later request, so credential shapes are redacted here, before any caller
 * clips an excerpt that could leave a fragment. The transcript itself stays raw.
 */
export function extractCompactionMessageText(message: AgentMessage): string {
  const content = Reflect.get(message, "content");
  const text =
    typeof content === "string"
      ? content.trim()
      : Array.isArray(content)
        ? content
            .flatMap((block) => {
              const value =
                block && typeof block === "object" ? Reflect.get(block, "text") : undefined;
              return typeof value === "string" && value.trim() ? [value.trim()] : [];
            })
            .join("\n")
        : "";
  return CREDENTIAL_PATTERNS.reduce((value, pattern) => value.replace(pattern, "[redacted]"), text);
}

/** Legacy producers cannot search past an independent input for a pending ask. */
export function extractCurrentCompactionUserRequest(
  messages: readonly AgentMessage[],
  getText: (message: Extract<AgentMessage, { role: "user" }>) => string,
): string | null {
  const message = messages.findLast((item) => item.role === "user");
  return message && isCompactionUserRequest(message) ? getText(message) : null;
}

/** Shared by summary input, preserved excerpts, and their token accounting. */
export function formatCompactionUserLabel(message: PersistedSenderCarrier): string {
  return `${compactionUserRole(message)}${formatPersistedSenderSuffix(message)}`;
}

export function removeGeneratedCompactionSection(
  summary: string | undefined,
  section: string,
): string | undefined {
  if (!summary) {
    return summary;
  }
  if (summary.startsWith(section)) {
    return summary.slice(section.length);
  }
  const delimitedSection = `\n\n${section}`;
  const sectionIndex = summary.indexOf(delimitedSection);
  return sectionIndex < 0
    ? summary
    : `${summary.slice(0, sectionIndex)}\n\n${summary.slice(sectionIndex + delimitedSection.length)}`;
}

/** Authoritative request owners clear stale model-written asks without rewriting other sections. */
export function clearCompactionPendingAskSection(summary: string): string {
  const heading = /^## Pending user asks[ \t]*$/mu.exec(summary);
  if (!heading) {
    return summary;
  }
  const contentStart = heading.index + heading[0].length;
  const remaining = summary.slice(contentStart + 1);
  const nextHeading = /^##[ \t]+\S.*$/mu.exec(remaining);
  return `${summary.slice(0, contentStart)}\nNone.${
    nextHeading ? `\n${remaining.slice(nextHeading.index)}` : ""
  }`;
}

/** Serialize LLM messages to plain text for summarization prompts. */
export function serializeConversation(messages: Message[]): string {
  const project = createConversationProjector();
  const parts: string[] = [];
  for (const message of messages) {
    for (const text of project(message).parts) {
      parts.push(text.full);
    }
  }
  return parts.join(ENTRY_SEPARATOR);
}

// A sampled tool result names its call; long arguments keep their start.
const MAX_CALL_LABEL_ARGUMENT_CHARS = 120;
const MAX_CALL_LABEL_CHARS = 300;

function formatCallLabel(name: string, args: ReadonlyArray<readonly [string, string]>): string {
  const label = `${name}(${args
    .map(
      ([key, text]) =>
        `${key}=${text.length > MAX_CALL_LABEL_ARGUMENT_CHARS ? `${truncateUtf16Safe(text, MAX_CALL_LABEL_ARGUMENT_CHARS)}...` : text}`,
    )
    .join(", ")})`;
  const bounded =
    label.length > MAX_CALL_LABEL_CHARS
      ? `${truncateUtf16Safe(label, MAX_CALL_LABEL_CHARS)}...)`
      : label;
  // Detach bounded labels from potentially enormous argument strings, preserving UTF-16.
  return copyString(bounded);
}

type ConversationProjectionState = { omissionMessages: number; callLabel?: string };

/** Project one actual source row, sharing exactly the same text rules on collection and reads. */
function projectConversationMessage(
  msg: Message,
  state: ConversationProjectionState,
  registerCall?: (id: string, label: string) => void,
): Array<ConversationEntryText & { user?: boolean }> {
  const parts: Array<ConversationEntryText & { user?: boolean }> = [];
  const add = (full: string, labeled = full, short = labeled, user = false) => {
    parts.push({ full, labeled, short, user });
  };
  // Carriers remain in replay for thinking-prefix binding, never in summaries.
  if (hasRuntimeContextMarker(msg)) {
    return parts;
  }
  if (msg.role === "user" || msg.role === "toolResult") {
    const { text, omissionText } = getCompactionContent(msg.content);
    // At most eight per-message omission notes and one aggregate overflow note.
    if (omissionText && state.omissionMessages++ === MAX_OMISSION_MESSAGES) {
      add(OMISSION_OVERFLOW);
    }
    const omission = state.omissionMessages <= MAX_OMISSION_MESSAGES ? omissionText : "";
    const project = (maxChars: number) =>
      [omission, msg.role === "toolResult" ? truncateForSummary(text, maxChars) : text]
        .filter(Boolean)
        .join("\n");
    const content = project(TOOL_RESULT_MAX_CHARS);
    if (content) {
      if (msg.role === "toolResult") {
        const label = state.callLabel ?? `${msg.toolName}(...)`;
        add(
          `[Tool result]: ${content}`,
          `[Tool result of ${label}]: ${content}`,
          `[Tool result of ${label}]: ${project(SAMPLED_TOOL_RESULT_MAX_CHARS)}`,
        );
      } else {
        const full = `[${formatCompactionUserLabel(msg)}]: ${content}`;
        add(full, full, full, isCompactionUserRequest(msg));
      }
    }
  } else if (msg.role === "assistant") {
    const textParts: string[] = [];
    const toolCalls: string[] = [];
    for (const block of msg.content) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "toolCall") {
        const args = Object.entries(block.arguments).map(
          ([key, value]) => [key, stringifyCompactionValue(value)] as const,
        );
        const argsStr = args.map(([key, text]) => `${key}=${text}`).join(", ");
        toolCalls.push(`${block.name}(${argsStr})`);
        registerCall?.(block.id, formatCallLabel(block.name, args));
      }
    }
    if (textParts.length > 0) {
      add(`[Assistant]: ${textParts.join("\n")}`);
    }
    if (toolCalls.length > 0) {
      add(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
    }
  }
  return parts;
}

/** Carry occurrence and omission state across rows, never source messages or full text. */
function createConversationProjector() {
  const callLabels = createToolCallOccurrenceQueue<string>();
  let omissionMessages = 0;
  return (message: Message) => {
    if (hasRuntimeContextMarker(message)) {
      return { parts: [], omissionMessages, callLabel: undefined };
    }
    if (message.role === "assistant") {
      // Results answer the latest assistant turn, not an earlier aborted one.
      callLabels.clear();
    }
    // Empty results still claim their occurrence. Intervening users do not clear it.
    const callLabel =
      message.role === "toolResult" ? callLabels.claim(message.toolCallId) : undefined;
    const before = omissionMessages;
    const state = { omissionMessages, callLabel };
    const parts = projectConversationMessage(message, state, callLabels.add);
    omissionMessages = state.omissionMessages;
    return { parts, omissionMessages: before, callLabel };
  };
}

/**
 * Collect one sequence in a single row-at-a-time pass. Retain only `descriptor`
 * for a lazy source; `text` is transient and lets array callers avoid reserialization.
 * A fresh collector defines a fresh summary sequence, including omission and call state.
 */
export function createConversationEntryCollector<TSource = number>(): (
  message: Message,
  source: TSource,
) => Array<{ descriptor: ConversationEntryDescriptor<TSource>; text: ConversationEntryText }> {
  const project = createConversationProjector();
  return (message, source) => {
    const { parts, omissionMessages, callLabel } = project(message);
    return parts.map((text, partIndex) => {
      const fullChars = estimateStringChars(text.full);
      const labeledChars =
        text.labeled === text.full ? fullChars : estimateStringChars(text.labeled);
      const shortChars =
        text.short === text.labeled ? labeledChars : estimateStringChars(text.short);
      return {
        descriptor: {
          source,
          partIndex,
          fullChars,
          labeledChars,
          shortChars,
          fullLength: text.full.length,
          labeledLength: text.labeled.length,
          shortLength: text.short.length,
          user: text.user === true,
          omissionMessages,
          callLabel,
        },
        text,
      };
    });
  };
}

/** Reconstruct a candidate part from its original message, without replaying preceding rows. */
export function serializeConversationEntry<TSource>(
  message: Message,
  descriptor: ConversationEntryDescriptor<TSource>,
  variant: ConversationTextVariant,
): string {
  const parts = projectConversationMessage(message, {
    omissionMessages: descriptor.omissionMessages,
    callLabel: descriptor.callLabel,
  });
  const part = parts[descriptor.partIndex];
  if (!part) {
    throw new Error("Compaction serialization source no longer contains the selected part");
  }
  return part[variant];
}

function collectConversationEntries(messages: Message[]) {
  const collect = createConversationEntryCollector();
  const entries: ReturnType<typeof collect> = [];
  for (const [index, message] of messages.entries()) {
    entries.push(...collect(message, index));
  }
  return entries;
}

/** Array callers use the same descriptor-driven selection kernel as lazy transcript readers. */
export function serializeConversationWithinBudget(
  messages: Message[],
  maxChars: number,
): BoundedConversation {
  // Only this eager array adapter retains text alongside its newly collected descriptors.
  const entries = collectConversationEntries(messages).map(({ descriptor, text }) =>
    Object.assign(descriptor, { text }),
  );
  return renderConversationEntriesWithinBudget(
    entries,
    maxChars,
    (entry, variant) => entry.text[variant],
  );
}
