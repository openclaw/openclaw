import { hasRuntimeContextMarker, type AssistantMessage, type Message } from "@openclaw/llm-core";
import { estimateStringChars } from "@openclaw/normalization-core/cjk-chars";
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { AgentMessage } from "../../types.js";
import { createToolCallOccurrenceQueue } from "../session/tool-result-pairing.js";

export type { FileOperations } from "../types.js";

export {
  createFileOps,
  mergeSummaryFileOperations,
  extractFileOpsFromMessages,
  computeFileLists,
  formatFileOperations,
} from "./file-operations.js";

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

export function extractCompactionMessageText(message: AgentMessage): string {
  const content = Reflect.get(message, "content");
  if (typeof content === "string") {
    return content.trim();
  }
  return Array.isArray(content)
    ? content
        .flatMap((block) => {
          const text = block && typeof block === "object" ? Reflect.get(block, "text") : undefined;
          return typeof text === "string" && text.trim() ? [text.trim()] : [];
        })
        .join("\n")
    : "";
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
  const parts: string[] = [];
  indexSerializedConversation(
    { length: messages.length, get: (index) => messages[index] },
    (text) => parts.push(text),
  );
  return parts.join(ENTRY_SEPARATOR);
}

const ENTRY_SEPARATOR = "\n\n";
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
  return label.length > MAX_CALL_LABEL_CHARS
    ? `${truncateUtf16Safe(label, MAX_CALL_LABEL_CHARS)}...)`
    : label;
}

/** Indexed access is snapshot-scoped; implementations need not retain parsed messages. */
export interface CompactionMessageSource {
  length: number;
  get(index: number): Message | undefined;
}

type SerializedEntry = {
  messageIndex: number;
  kind: "content" | "assistant" | "calls" | "overflow";
  includeOmission?: boolean;
  callLabel?: string;
};

function renderSerializedEntry(entry: SerializedEntry, message: Message, sampled: boolean): string {
  if (entry.kind === "overflow") {
    return OMISSION_OVERFLOW;
  }
  if (entry.kind === "content" && (message.role === "user" || message.role === "toolResult")) {
    const { text, omissionText } = getCompactionContent(message.content);
    const content = [
      entry.includeOmission ? omissionText : "",
      message.role === "toolResult" ? truncateForSummary(text, TOOL_RESULT_MAX_CHARS) : text,
    ]
      .filter(Boolean)
      .join("\n");
    const label =
      message.role === "toolResult"
        ? sampled
          ? `Tool result of ${entry.callLabel}`
          : "Tool result"
        : formatCompactionUserLabel(message);
    return `[${label}]: ${content}`;
  }
  if (message.role === "assistant") {
    if (entry.kind === "assistant") {
      return `[Assistant]: ${message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")}`;
    }
    return `[Assistant tool calls]: ${message.content
      .flatMap((block) =>
        block.type === "toolCall"
          ? [
              `${block.name}(${Object.entries(block.arguments)
                .map(([key, value]) => `${key}=${stringifyCompactionValue(value)}`)
                .join(", ")})`,
            ]
          : [],
      )
      .join("; ")}`;
  }
  throw new Error("Compaction serialization source changed during its snapshot");
}

/** Index sizes and bounded call labels, not rendered conversation payloads. */
export function createSerializedConversationSource(
  messages: CompactionMessageSource,
): SerializedConversationSource {
  return indexSerializedConversation(messages);
}

function indexSerializedConversation(
  messages: CompactionMessageSource,
  consume?: (text: string) => void,
): SerializedConversationSource {
  const entries: SerializedEntry[] = [];
  const weights: number[] = [];
  const userEntries: number[] = [];
  const callLabels = createToolCallOccurrenceQueue<string>();
  let omissionMessages = 0;
  let totalChars = 0;
  const add = (entry: SerializedEntry, message: Message, rendered?: string) => {
    const text = rendered ?? renderSerializedEntry(entry, message, false);
    consume?.(text);
    totalChars += estimateStringChars(text) + (entries.length > 0 ? ENTRY_SEPARATOR.length : 0);
    weights.push(
      estimateStringChars(entry.callLabel ? renderSerializedEntry(entry, message, true) : text),
    );
    entries.push(entry);
  };
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages.get(messageIndex);
    if (!message || hasRuntimeContextMarker(message)) {
      continue;
    }
    if (message.role === "user" || message.role === "toolResult") {
      // Empty results still claim their occurrence, matching replay ordering.
      const callLabel =
        message.role === "toolResult"
          ? (callLabels.claim(message.toolCallId) ?? `${message.toolName}(...)`)
          : undefined;
      const { text, omissionText } = getCompactionContent(message.content);
      if (omissionText && omissionMessages++ === MAX_OMISSION_MESSAGES) {
        add({ messageIndex, kind: "overflow" }, message);
      }
      const includeOmission = omissionMessages <= MAX_OMISSION_MESSAGES;
      if (!text && !(includeOmission && omissionText)) {
        continue;
      }
      if (isCompactionUserRequest(message)) {
        userEntries.push(entries.length);
      }
      add({ messageIndex, kind: "content", includeOmission, callLabel }, message);
    } else if (message.role === "assistant") {
      callLabels.clear();
      let hasText = false;
      const toolCalls: string[] = [];
      for (const block of message.content) {
        if (block.type === "text") {
          hasText = true;
        } else if (block.type === "toolCall") {
          const args = Object.entries(block.arguments).map(
            ([key, value]) => [key, stringifyCompactionValue(value)] as const,
          );
          callLabels.add(block.id, formatCallLabel(block.name, args));
          toolCalls.push(
            `${block.name}(${args.map(([key, value]) => `${key}=${value}`).join(", ")})`,
          );
        }
      }
      if (hasText) {
        add({ messageIndex, kind: "assistant" }, message);
      }
      if (toolCalls.length > 0) {
        add(
          { messageIndex, kind: "calls" },
          message,
          `[Assistant tool calls]: ${toolCalls.join("; ")}`,
        );
      }
    }
  }
  return {
    count: entries.length,
    totalChars,
    weights,
    userEntries,
    render(index, sampled) {
      const entry = entries[index];
      const message = entry && messages.get(entry.messageIndex);
      if (!entry || !message) {
        throw new Error("Compaction serialization source is missing a selected message");
      }
      return renderSerializedEntry(entry, message, sampled);
    },
  };
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
// Covers truncation and elision markers for any UTF-16 length.
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

/** A snapshot's serialization facts; payloads need only be rendered when selected. */
export interface SerializedConversationSource {
  count: number;
  /** Unlabelled CJK-weighted total, including separators, for the unchanged-input path. */
  totalChars: number;
  /** CJK-weighted entry sizes with tool-call labels, used when sampling. */
  weights: readonly number[];
  userEntries: readonly number[];
  /** Render from the same snapshot used to compute the selection facts. */
  render(index: number, sampled: boolean): string;
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
  return serializeConversationSourceWithinBudget(
    createSerializedConversationSource({
      length: messages.length,
      get: (index) => messages[index],
    }),
    maxChars,
  );
}

/** Apply the same sampling policy without retaining unselected serialized payloads. */
export function serializeConversationSourceWithinBudget(
  source: SerializedConversationSource,
  maxChars: number,
): BoundedConversation {
  const separatorChars = ENTRY_SEPARATOR.length;
  if (source.totalChars <= maxChars) {
    return {
      text: Array.from({ length: source.count }, (_, index) => source.render(index, false)).join(
        ENTRY_SEPARATOR,
      ),
      omittedEntries: 0,
      trimmedEntries: 0,
    };
  }
  const { weights } = source;

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
    const rightOpen = index < source.count - 1 && !selected.has(index + 1);
    const markerDelta = leftOpen && rightOpen ? 1 : !leftOpen && !rightOpen ? -1 : 0;
    const markerCost = markerDelta * OMISSION_MARKER_CHARS;
    const entryLimit = Math.min(limit - markerCost, maxEntryChars + separatorChars);
    let chars = (weights[index] ?? 0) + separatorChars;
    // Reject an unaffordable entry before acquiring its payload. The trimming
    // helper requires this minimum room independent of the entry's contents.
    if (
      chars > entryLimit &&
      entryLimit - separatorChars - ELISION_MARKER_RESERVE_CHARS < MIN_TRIMMED_ENTRY_CHARS
    ) {
      return false;
    }
    if (chars <= entryLimit && usedChars + chars + markerCost > maxChars) {
      return false;
    }
    const entry = source.render(index, true);
    let text = entry;
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
  let tailStart = source.count;
  const tailLimit = Math.floor(maxChars * SUMMARY_INPUT_TAIL_SHARE);
  for (let index = source.count - 1; index >= 0; index -= 1) {
    const remaining = tailLimit - usedChars;
    const verbatim = (weights[index] ?? 0) + separatorChars <= remaining;
    if ((!verbatim && tailStart !== source.count) || !take(index, remaining)) {
      break;
    }
    tailStart = index;
  }

  // Older user messages state what was asked, decided and corrected; a fact the
  // user gave once must not depend on where the samples fall. When they do not
  // all fit, they are spread evenly across the history, newest first.
  const olderUsers = source.userEntries.filter((index) => index < tailStart);
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
  for (let index = 0; index <= source.count; index += 1) {
    const text = selected.get(index);
    if (text === undefined && index < source.count) {
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
