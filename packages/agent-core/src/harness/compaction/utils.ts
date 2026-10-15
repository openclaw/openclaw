import { hasRuntimeContextMarker, type AssistantMessage, type Message } from "@openclaw/llm-core";
import { estimateStringChars } from "@openclaw/normalization-core/cjk-chars";
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { AgentMessage } from "../../types.js";
import { createToolCallOccurrenceQueue } from "../session/tool-result-pairing.js";
import type { FileOperations } from "../types.js";

export type { FileOperations } from "../types.js";

function normalizeFileToolName(value: unknown): string {
  const name = typeof value === "string" ? value.toLowerCase() : "";
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

/** Add file operations from tool calls and results to an accumulator. */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
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

  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return;
  }
  for (const block of message.content) {
    const toolCall = asRecord(block);
    if (toolCall?.type !== "toolCall") {
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
export const MAX_FILE_OPS_SECTION_CHARS = 2_000;
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
  const sliced = truncateUtf16Safe(text, maxChars);
  const truncatedChars = text.length - sliced.length;
  return `${sliced}\n\n[... ${truncatedChars} more characters truncated]`;
}

/** Extract text that compaction both estimates and includes in summary prompts. */
function getCompactionContentBlockText(block: {
  type: string;
  content?: unknown;
  text?: string;
}): string {
  if (
    (block.type === "text" || block.type === "toolResult" || block.type === "tool_result") &&
    block.text
  ) {
    return block.text;
  }
  return (block.type === "toolResult" || block.type === "tool_result") &&
    typeof block.content === "string"
    ? block.content
    : "";
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
            const blockText = getCompactionContentBlockText(block);
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
type PersistedSenderCarrier = {
  role: string;
};

function readPersistedSender(message: PersistedSenderCarrier) {
  if (message.role !== "user") {
    return undefined;
  }
  const metadata = asRecord(Reflect.get(message, "__openclaw"));
  if (!metadata) {
    return undefined;
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
  return sender.id ? sender : undefined;
}

/**
 * Return exactly the persisted-sender text which is projected into a user
 * conversation label. Keep this shared with token accounting: adding a label
 * to the prompt without charging it can make bounded compaction overflow.
 */
export function formatPersistedSenderSuffix(message: PersistedSenderCarrier): string {
  const sender = readPersistedSender(message);
  return sender ? ` sender=${JSON.stringify(sender)}` : "";
}

/** Serialize LLM messages to plain text for summarization prompts. */
export function serializeConversation(messages: Message[]): string {
  return serializeConversationEntries(messages).entries.join(ENTRY_SEPARATOR);
}

const ENTRY_SEPARATOR = "\n\n";
// A sampled tool result names its call; long arguments keep their start.
const MAX_CALL_LABEL_ARGUMENT_CHARS = 120;
const MAX_CALL_LABEL_CHARS = 300;

function formatCallLabel(name: string, args: Record<string, unknown>): string {
  const label = `${name}(${Object.entries(args)
    .map(([key, value]) => {
      const text = stringifyCompactionValue(value);
      return `${key}=${text.length > MAX_CALL_LABEL_ARGUMENT_CHARS ? `${truncateUtf16Safe(text, MAX_CALL_LABEL_ARGUMENT_CHARS)}...` : text}`;
    })
    .join(", ")})`;
  return label.length > MAX_CALL_LABEL_CHARS
    ? `${truncateUtf16Safe(label, MAX_CALL_LABEL_CHARS)}...)`
    : label;
}

function serializeConversationEntries(messages: Message[]): {
  entries: string[];
  /** Tool-result entries rendered with the call that produced them, for sampled input. */
  labeledResults: Map<number, string>;
  /** User-message entries, which carry the asks, decisions and corrections. */
  userEntries: number[];
} {
  const parts: string[] = [];
  const labeledResults = new Map<number, string>();
  const userEntries: number[] = [];
  // Providers may repeat a call ID; each result claims the oldest unanswered call with it.
  const callLabels = createToolCallOccurrenceQueue<string>();
  let omissionMessages = 0;

  for (const msg of messages) {
    // Carriers remain in replay for thinking-prefix binding, not in summaries
    // where runtime-only context could become durable assistant-authored text.
    if (hasRuntimeContextMarker(msg)) {
      continue;
    }
    if (msg.role === "user" || msg.role === "toolResult") {
      // Claim even for an empty result, so a later result with the same ID gets its own call.
      const callLabel = msg.role === "toolResult" ? callLabels.claim(msg.toolCallId) : undefined;
      const { text, omissionText } = getCompactionContent(msg.content);
      // Fixed ASCII bounds additions to 8 * (82 markers + 17 wrapper) + 55 overflow = 847 bytes.
      // Keep the aggregate outside truncation too; later omissions must never disappear silently.
      if (omissionText && omissionMessages++ === MAX_OMISSION_MESSAGES) {
        parts.push(OMISSION_OVERFLOW);
      }
      const content = [
        omissionMessages <= MAX_OMISSION_MESSAGES ? omissionText : "",
        msg.role === "toolResult" ? truncateForSummary(text, TOOL_RESULT_MAX_CHARS) : text,
      ]
        .filter(Boolean)
        .join("\n");
      if (!content) {
        continue;
      }
      if (msg.role === "toolResult") {
        const label = callLabel ?? `${msg.toolName}(...)`;
        labeledResults.set(parts.length, `[Tool result of ${label}]: ${content}`);
        parts.push(`[Tool result]: ${content}`);
      } else {
        userEntries.push(parts.length);
        parts.push(`[User${formatPersistedSenderSuffix(msg)}]: ${content}`);
      }
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      // Results answer the latest assistant turn; calls an earlier turn left
      // unanswered (aborted, failed) must not label them.
      callLabels.clear();

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "toolCall") {
          const argsStr = Object.entries(block.arguments)
            .map(([k, v]) => `${k}=${stringifyCompactionValue(v)}`)
            .join(", ");
          toolCalls.push(`${block.name}(${argsStr})`);
          callLabels.add(block.id, formatCallLabel(block.name, block.arguments));
        }
      }

      if (textParts.length > 0) {
        parts.push(`[Assistant]: ${textParts.join("\n")}`);
      }
      if (toolCalls.length > 0) {
        parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
      }
    }
  }

  return { entries: parts, labeledResults, userEntries };
}

/**
 * Upper bound for the conversation text of one summary request, in CJK-weighted
 * characters (about 40k tokens). Summary latency and cost follow this bound, not
 * the session size, so a 1M-token window compacts as fast as a 128k one.
 */
export const MAX_SUMMARY_INPUT_CHARS = 160_000;
const MAX_SAMPLED_ENTRY_CHARS = 6_000;
const MIN_TRIMMED_ENTRY_CHARS = 200;
const TRIMMED_ENTRY_HEAD_SHARE = 0.7;
// Covers "\n\n[... N characters omitted ...]\n\n" for any UTF-16 length.
const ELISION_MARKER_RESERVE_CHARS = 64;
const SUMMARY_INPUT_TAIL_SHARE = 0.5;
const SUMMARY_INPUT_USER_SHARE = 0.25;
const SUMMARY_INPUT_HEAD_SHARE = 0.1;
const SUMMARY_INPUT_MIDDLE_SLICES = 8;
// Older user messages share their budget evenly, within these bounds each.
const MAX_USER_ENTRY_CHARS = 2_000;
const MIN_USER_ENTRY_CHARS = 400;
// A gap marker ("[... 12345 entries omitted ...]") and its separator stay under 40 characters.
const OMISSION_MARKER_CHARS = 40;

/**
 * Keep both ends of `text` within `maxChars` CJK-weighted characters: the start
 * usually states the request and the end its latest instruction or result.
 * Weighted length is at least the UTF-16 length, so each binary search is
 * bounded by the weight budget, not by the size of the text.
 */
function elideMiddleWithinWeight(text: string, maxChars: number): string | undefined {
  const available = maxChars - ELISION_MARKER_RESERVE_CHARS;
  if (available < MIN_TRIMMED_ENTRY_CHARS) {
    return undefined;
  }
  const headBudget = Math.floor(available * TRIMMED_ENTRY_HEAD_SHARE);
  let low = 0;
  let high = Math.min(text.length, headBudget);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateStringChars(truncateUtf16Safe(text, mid)) <= headBudget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  const head = truncateUtf16Safe(text, low);
  const tailBudget = available - estimateStringChars(head);
  low = Math.max(head.length, text.length - tailBudget);
  high = text.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (estimateStringChars(sliceUtf16Safe(text, mid)) <= tailBudget) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  const tail = sliceUtf16Safe(text, low);
  return `${head}\n\n[... ${text.length - head.length - tail.length} characters omitted ...]\n\n${tail}`;
}

export interface BoundedConversation {
  text: string;
  /** Entries left out entirely; the text names each gap where it occurs. */
  omittedEntries: number;
  /** Entries kept with their middle elided. */
  trimmedEntries: number;
}

/**
 * Serialize messages for one summary request within `maxChars` CJK-weighted
 * characters. Small inputs are unchanged. Larger inputs keep, in this order:
 * the newest entries verbatim (half the budget); older user messages, which
 * carry the asks, decisions and corrections (a quarter, newest first, each up
 * to 2,000 characters); the oldest entries (a tenth); and eight evenly spaced
 * runs of what remains. Sampled entries are trimmed to 6,000 characters, every
 * gap is marked with its entry count, and each tool result names its call,
 * because sampling can separate the two. The transcript itself is not changed.
 */
export function serializeConversationWithinBudget(
  messages: Message[],
  maxChars: number,
): BoundedConversation {
  const serialized = serializeConversationEntries(messages);
  const separatorChars = ENTRY_SEPARATOR.length;
  const totalChars =
    serialized.entries.reduce((sum, entry) => sum + estimateStringChars(entry), 0) +
    separatorChars * Math.max(0, serialized.entries.length - 1);
  if (totalChars <= maxChars) {
    return {
      text: serialized.entries.join(ENTRY_SEPARATOR),
      omittedEntries: 0,
      trimmedEntries: 0,
    };
  }
  const entries = serialized.entries.map(
    (entry, index) => serialized.labeledResults.get(index) ?? entry,
  );
  const weights = entries.map((entry) => estimateStringChars(entry));

  const selected = new Map<number, string>();
  let trimmedEntries = 0;
  // Every maximal run of left-out entries renders one marker; the whole span starts as one.
  let usedChars = OMISSION_MARKER_CHARS;

  // Keeps the entry within `limit`, eliding its middle when needed. The cost
  // includes the change in gap markers: taking an entry inside a gap splits it.
  const take = (index: number, limit: number, maxEntryChars = limit): boolean => {
    if (selected.has(index)) {
      return true;
    }
    const leftOpen = index > 0 && !selected.has(index - 1);
    const rightOpen = index < entries.length - 1 && !selected.has(index + 1);
    const markerDelta = leftOpen && rightOpen ? 1 : !leftOpen && !rightOpen ? -1 : 0;
    const markerCost = markerDelta * OMISSION_MARKER_CHARS;
    const entry = entries[index] ?? "";
    const entryLimit = Math.min(limit - markerCost, maxEntryChars + separatorChars);
    let text = entry;
    let chars = (weights[index] ?? 0) + separatorChars;
    if (chars > entryLimit) {
      const trimmed = elideMiddleWithinWeight(entry, entryLimit - separatorChars);
      if (trimmed === undefined) {
        return false;
      }
      text = trimmed;
      chars = estimateStringChars(trimmed) + separatorChars;
    }
    // Shares only order the passes; the whole input never exceeds maxChars.
    if (usedChars + chars + markerCost > maxChars) {
      return false;
    }
    if (text !== entry) {
      trimmedEntries += 1;
    }
    selected.set(index, text);
    usedChars += chars + markerCost;
    return true;
  };

  // Newest entries carry the live task, so they stay verbatim. Only the newest
  // entry may be trimmed, when it alone exceeds the tail share.
  let tailStart = entries.length;
  const tailLimit = Math.floor(maxChars * SUMMARY_INPUT_TAIL_SHARE);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const remaining = tailLimit - usedChars;
    const verbatim = (weights[index] ?? 0) + separatorChars <= remaining;
    if ((!verbatim && tailStart !== entries.length) || !take(index, remaining)) {
      break;
    }
    tailStart = index;
  }

  // Older user messages state what was asked, decided and corrected; a fact the
  // user gave once must not depend on where the samples fall. When they do not
  // all fit, they are spread evenly across the history, newest first.
  const olderUsers = serialized.userEntries.filter((index) => index < tailStart);
  if (olderUsers.length > 0) {
    const userBudget = Math.floor(maxChars * SUMMARY_INPUT_USER_SHARE);
    const userLimit = usedChars + userBudget;
    const userEntryChars = Math.min(
      MAX_USER_ENTRY_CHARS,
      Math.max(
        MIN_USER_ENTRY_CHARS,
        Math.floor(userBudget / olderUsers.length - OMISSION_MARKER_CHARS),
      ),
    );
    const userCosts = olderUsers.reduce(
      (sum, index) =>
        sum +
        Math.min((weights[index] ?? 0) + separatorChars, userEntryChars + separatorChars) +
        OMISSION_MARKER_CHARS,
      0,
    );
    const stride = Math.max(1, userCosts / userBudget);
    for (let position = olderUsers.length - 1; position >= 0; position -= stride) {
      const index = olderUsers[Math.round(position)];
      if (index === undefined || !take(index, userLimit - usedChars, userEntryChars)) {
        break;
      }
    }
  }

  // The oldest entries usually state the goal and the constraints of the session.
  let headEnd = 0;
  const headLimit = usedChars + Math.floor(maxChars * SUMMARY_INPUT_HEAD_SHARE);
  while (headEnd < tailStart && take(headEnd, headLimit - usedChars, MAX_SAMPLED_ENTRY_CHARS)) {
    headEnd += 1;
  }

  // Evenly spaced runs show how the remaining span developed.
  const middleCount = tailStart - headEnd;
  if (middleCount > 0) {
    const sliceLimit = Math.floor((maxChars - usedChars) / SUMMARY_INPUT_MIDDLE_SLICES);
    let nextFree = headEnd;
    for (let slice = 0; slice < SUMMARY_INPUT_MIDDLE_SLICES; slice += 1) {
      let index = Math.max(
        nextFree,
        headEnd + Math.floor((slice * middleCount) / SUMMARY_INPUT_MIDDLE_SLICES),
      );
      const sliceEnd = usedChars + sliceLimit;
      while (index < tailStart && take(index, sliceEnd - usedChars, MAX_SAMPLED_ENTRY_CHARS)) {
        index += 1;
      }
      nextFree = index;
    }
  }

  const parts: string[] = [];
  let omittedEntries = 0;
  let gap = 0;
  // The extra iteration flushes a trailing gap.
  for (let index = 0; index <= entries.length; index += 1) {
    const text = selected.get(index);
    if (text === undefined && index < entries.length) {
      gap += 1;
      continue;
    }
    if (gap > 0) {
      parts.push(`[... ${gap} ${gap === 1 ? "entry" : "entries"} omitted ...]`);
      omittedEntries += gap;
      gap = 0;
    }
    if (text !== undefined) {
      parts.push(text);
    }
  }
  return { text: parts.join(ENTRY_SEPARATOR), omittedEntries, trimmedEntries };
}
