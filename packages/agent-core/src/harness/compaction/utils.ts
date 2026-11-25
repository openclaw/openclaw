import { hasRuntimeContextMarker, type AssistantMessage, type Message } from "@openclaw/llm-core";
import { estimateStringChars } from "@openclaw/normalization-core/cjk-chars";
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { AgentMessage } from "../../types.js";
import { createToolCallOccurrenceQueue } from "../session/tool-result-pairing.js";
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
  type BoundedConversation,
  type ConversationEntryDescriptor,
  type ConversationTextVariant,
} from "./conversation-serialization.js";

export type { FileOperations } from "../types.js";

export {
  collectFileOperationMessageFact,
  computeFileLists,
  createFileOps,
  extractFileOpsFromFacts,
  extractFileOpsFromMessages,
  formatFileOperations,
  mergeSummaryFileOperations,
  type FileOperationMessageFact,
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

/** One block projection shared by payload serialization and detached token facts. */
export function projectCompactionContentBlock(block: {
  type: string;
  content?: unknown;
  text?: string;
}): { text: string; omission?: string } {
  let text = "";
  if (
    (block.type === "text" || block.type === "toolResult" || block.type === "tool_result") &&
    block.text
  ) {
    text = block.text;
  } else if (
    (block.type === "toolResult" || block.type === "tool_result") &&
    typeof block.content === "string"
  ) {
    text = block.content;
  }
  return {
    text,
    ...(block.type !== "text" && !text
      ? {
          omission:
            block.type === "image"
              ? "[image data omitted from summary input]"
              : "[non-text data omitted from summary input]",
        }
      : {}),
  };
}

/** Project summary content once so rendering and token accounting share omission facts. */
export function getCompactionContent(
  content: string | Array<{ type: string; content?: unknown; text?: string }>,
): { text: string; omissionText: string } {
  if (typeof content === "string") {
    return { text: content, omissionText: "" };
  }
  const omissions = new Set<string>();
  const parts = content.map((block) => {
    const projected = projectCompactionContentBlock(block);
    if (projected.omission) {
      omissions.add(projected.omission);
    }
    return projected.text;
  });
  return { text: parts.filter(Boolean).join("\n"), omissionText: [...omissions].join("\n") };
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

function omissionPhase(count: number): 0 | 1 | 2 {
  return count < MAX_OMISSION_MESSAGES ? 0 : count === MAX_OMISSION_MESSAGES ? 1 : 2;
}

type ConversationPart = ConversationEntryText & { user?: boolean; toolResult?: true };

/** Project one actual source row, sharing exactly the same text rules on collection and reads. */
function projectConversationMessage(
  msg: Message,
  state: ConversationProjectionState,
  registerCall?: (id: string, label: string) => void,
): ConversationPart[] {
  const parts: ConversationPart[] = [];
  const add = (full: string, labeled = full, short = labeled, user = false, toolResult?: true) => {
    parts.push({ full, labeled, short, user, toolResult });
  };
  // Carriers remain in replay for thinking-prefix binding, never in summaries.
  if (hasRuntimeContextMarker(msg)) {
    return parts;
  }
  if (msg.role === "user" || msg.role === "toolResult") {
    const { text, omissionText } = getCompactionContent(msg.content);
    // At most eight per-message omission notes and one aggregate overflow note.
    const phase = omissionPhase(state.omissionMessages);
    if (omissionText) {
      state.omissionMessages += 1;
    }
    if (omissionText && phase === 1) {
      add(OMISSION_OVERFLOW);
    }
    const omission = phase === 0 ? omissionText : "";
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
          false,
          true,
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
function createConversationSequenceState() {
  const callLabels = createToolCallOccurrenceQueue<string>();
  let omissionMessages = 0;
  return {
    begin(role: Message["role"], resultId?: string): ConversationProjectionState {
      if (role === "assistant") {
        // Results answer the latest assistant turn, not an earlier aborted one.
        callLabels.clear();
      }
      return {
        omissionMessages,
        // Empty results still claim their occurrence. Intervening users do not clear it.
        callLabel:
          role === "toolResult" && resultId !== undefined ? callLabels.claim(resultId) : undefined,
      };
    },
    finish(state: ConversationProjectionState) {
      omissionMessages = state.omissionMessages;
    },
    add: callLabels.add,
  };
}

function createConversationProjector() {
  const sequence = createConversationSequenceState();
  return (message: Message) => {
    if (hasRuntimeContextMarker(message)) {
      return { parts: [], omissionMessages: 0, callLabel: undefined };
    }
    const state = sequence.begin(
      message.role,
      message.role === "toolResult" ? message.toolCallId : undefined,
    );
    const before = state.omissionMessages;
    const parts = projectConversationMessage(message, state, sequence.add);
    sequence.finish(state);
    return { parts, omissionMessages: before, callLabel: state.callLabel };
  };
}

function describeConversationParts<TSource>(
  parts: ConversationPart[],
  source: TSource,
  state: ConversationProjectionState,
) {
  return parts.map((text, partIndex) => {
    const fullChars = estimateStringChars(text.full);
    const labeledChars = text.labeled === text.full ? fullChars : estimateStringChars(text.labeled);
    const shortChars = text.short === text.labeled ? labeledChars : estimateStringChars(text.short);
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
        toolResult: text.toolResult,
        ...state,
      },
      text,
    };
  });
}

export type ConversationMessageFact<TSource = number> = {
  role: Message["role"];
  skipped: boolean;
  resultId?: string;
  resultLabelChars: number;
  resultLabelLength: number;
  calls: Array<{ id: string; label: string }>;
  omission: boolean;
  variants: [
    ConversationEntryDescriptor<TSource>[],
    ConversationEntryDescriptor<TSource>[],
    ConversationEntryDescriptor<TSource>[],
  ];
};

/** Retain range-independent descriptors, never the source row or its serialized text. */
export function collectConversationMessageFact<TSource>(
  message: Message,
  source: TSource,
): ConversationMessageFact<TSource> {
  const calls: ConversationMessageFact<TSource>["calls"] = [];
  const state = { omissionMessages: 0 };
  const parts = projectConversationMessage(message, state, (id, label) =>
    calls.push({ id, label }),
  );
  const normal = describeConversationParts(parts, source, { omissionMessages: 0 }).map(
    ({ descriptor }) => descriptor,
  );
  const omission = state.omissionMessages > 0;
  const variant = (omissionMessages: number) =>
    omission
      ? describeConversationParts(
          projectConversationMessage(message, { omissionMessages }),
          source,
          { omissionMessages },
        ).map(({ descriptor }) => descriptor)
      : normal;
  const resultLabel = message.role === "toolResult" ? `${message.toolName}(...)` : "";
  // Only media-bearing rows need all three omission states. This makes arbitrary
  // selected ranges exact without another full-window payload decode.
  return {
    role: message.role,
    skipped: hasRuntimeContextMarker(message),
    resultId: message.role === "toolResult" ? message.toolCallId : undefined,
    resultLabelChars: estimateStringChars(resultLabel),
    resultLabelLength: resultLabel.length,
    calls,
    omission,
    variants: [normal, variant(MAX_OMISSION_MESSAGES), variant(MAX_OMISSION_MESSAGES + 1)],
  };
}

/** Rebase call occurrences and omission state over the exact selected sequence. */
export function collectConversationRangeDescriptors<TSource>(
  facts: Iterable<ConversationMessageFact<TSource>>,
): ConversationEntryDescriptor<TSource>[] {
  const sequence = createConversationSequenceState();
  const descriptors: ConversationEntryDescriptor<TSource>[] = [];
  for (const fact of facts) {
    if (fact.skipped) {
      continue;
    }
    const state = sequence.begin(fact.role, fact.resultId);
    for (const descriptor of fact.variants[omissionPhase(state.omissionMessages)]) {
      const label = descriptor.toolResult ? state.callLabel : undefined;
      const chars = label === undefined ? 0 : estimateStringChars(label) - fact.resultLabelChars;
      const length = label === undefined ? 0 : label.length - fact.resultLabelLength;
      descriptors.push({
        ...descriptor,
        omissionMessages: state.omissionMessages,
        callLabel: label,
        labeledChars: descriptor.labeledChars + chars,
        shortChars: descriptor.shortChars + chars,
        labeledLength: descriptor.labeledLength + length,
        shortLength: descriptor.shortLength + length,
      });
    }
    state.omissionMessages += Number(fact.omission);
    sequence.finish(state);
    for (const call of fact.calls) {
      sequence.add(call.id, call.label);
    }
  }
  return descriptors;
}

/**
 * Collect one sequence in a single row-at-a-time pass. Retain only `descriptor`
 * for a lazy source; `text` is transient and lets array callers avoid reserialization.
 * A fresh collector defines a fresh summary sequence, including omission and call state.
 */
function createConversationEntryCollector<TSource = number>(): (
  message: Message,
  source: TSource,
) => Array<{ descriptor: ConversationEntryDescriptor<TSource>; text: ConversationEntryText }> {
  const project = createConversationProjector();
  return (message, source) => {
    const { parts, omissionMessages, callLabel } = project(message);
    return describeConversationParts(parts, source, { omissionMessages, callLabel });
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
