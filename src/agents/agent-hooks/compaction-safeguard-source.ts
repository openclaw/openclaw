import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  formatRequiredAskContext,
  MAX_COMPACTION_SUMMARY_CHARS,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import {
  extractCurrentCompactionUserRequest,
  extractCompactionMessageText as extractMessageText,
  formatCompactionUserLabel,
} from "../../../packages/agent-core/src/harness/compaction/utils.js";
import {
  classifyToolUseResultPairing,
  extractToolCallsFromAssistant,
  extractToolResultId,
  isSyntheticMissingToolResult,
  SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY,
} from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import { createRealConversationClassifier } from "../compaction-real-conversation.js";
import { isOpenClawRuntimeContextCustomMessage } from "../internal-runtime-context.js";
import type { AgentMessage } from "../runtime/index.js";
import { sanitizeToolUseResultPairing } from "../session-transcript-repair.js";
import { extractOpaqueIdentifiers } from "./compaction-safeguard-quality.js";
import {
  collectToolFailures,
  formatToolFailuresSection,
} from "./compaction-safeguard-tool-failures.js";

export interface SafeguardMessageSource {
  readonly length: number;
  get(index: number): AgentMessage | undefined;
}
export type ContextSection = {
  text: string;
  segmentStarts: number[];
  truncatedLoss?: "split-turn-head" | "preserved-turn-head";
};
const MAX_SPLIT_TURN_CONTEXT_CHARS = Math.floor(MAX_COMPACTION_SUMMARY_CHARS / 2);
const SPLIT_TURN_TRUNCATED_MARKER = "[Earlier split-turn messages truncated]\n";
const PRESERVED_TURNS_TRUNCATED_MARKER = "[Earlier preserved messages truncated]\n";
const MAX_RECENT_TURN_TEXT_CHARS = 600;
const MAX_PRESERVED_TOOL_RESULT_CHARS = 160;

export function arraySafeguardSource(messages: AgentMessage[]): SafeguardMessageSource {
  return { length: messages.length, get: (index) => messages[index] };
}
function selectSource(source: SafeguardMessageSource, indexes: number[]): SafeguardMessageSource {
  return {
    length: indexes.length,
    get: (index) => (indexes[index] === undefined ? undefined : source.get(indexes[index])),
  };
}
export function materializeSafeguardSource(source: SafeguardMessageSource): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let index = 0; index < source.length; index++) {
    const message = source.get(index);
    if (message) {
      messages.push(message);
    }
  }
  return messages;
}
/** Snapshot-local indexes and ownership facts; no transcript content survives this scan. */
type IndexedMessages = {
  source: SafeguardMessageSource;
  indexes: number[];
  roles: AgentMessage["role"][];
  shells: AgentMessage[];
  lastUserIndex: number;
};
function emptyIndex(source: SafeguardMessageSource): IndexedMessages {
  return { source, indexes: [], roles: [], shells: [], lastUserIndex: -1 };
}
function* indexMessages(indexed: IndexedMessages, stripRuntimeContext = false) {
  for (let index = 0; index < indexed.source.length; index++) {
    const message = indexed.source.get(index);
    if (!message || (stripRuntimeContext && isOpenClawRuntimeContextCustomMessage(message))) {
      continue;
    }
    if (message.role === "user") {
      indexed.lastUserIndex = indexed.indexes.length;
    }
    indexed.indexes.push(index);
    indexed.roles.push(message.role);
    indexed.shells.push(pairingShell(message));
    yield message;
  }
}
function indexSource(source: SafeguardMessageSource): IndexedMessages {
  const indexed = emptyIndex(source);
  const messages = indexMessages(indexed);
  while (!messages.next().done) {
    // Consume the row before the source releases it; only the index retains facts.
  }
  return indexed;
}
function indexedSource(indexed: IndexedMessages): SafeguardMessageSource {
  return indexed.indexes.length === indexed.source.length
    ? indexed.source
    : selectSource(indexed.source, indexed.indexes);
}
function selectIndexedMessages(indexed: IndexedMessages, positions: number[]): IndexedMessages {
  // Positions are selected from this index; its parallel facts share one append owner.
  const roles = positions.map((position) => indexed.roles[position]!);
  return {
    source: indexed.source,
    indexes: positions.map((position) => indexed.indexes[position]!),
    roles,
    shells: positions.map((position) => indexed.shells[position]!),
    lastUserIndex: roles.lastIndexOf("user"),
  };
}
function concatenateSources(
  first: SafeguardMessageSource,
  second: SafeguardMessageSource,
): SafeguardMessageSource {
  if (first.length === 0) {
    return second;
  }
  if (second.length === 0) {
    return first;
  }
  return {
    length: first.length + second.length,
    get: (index) => (index < first.length ? first.get(index) : second.get(index - first.length)),
  };
}
function containsRealConversation(messages: Iterable<AgentMessage>): boolean {
  const classify = createRealConversationClassifier();
  for (const message of messages) {
    if (!isOpenClawRuntimeContextCustomMessage(message) && classify(message)) {
      return true;
    }
  }
  return false;
}
function currentUserAsk(indexed: IndexedMessages): string | null {
  if (indexed.lastUserIndex < 0) {
    return null;
  }
  const message = indexed.source.get(indexed.indexes[indexed.lastUserIndex]!);
  return message ? extractCurrentCompactionUserRequest([message], extractMessageText) : null;
}
function splitPreservedIndexes(indexed: IndexedMessages, preserveTurns: number) {
  const conversationIndexes: number[] = [];
  const userIndexes: number[] = [];
  if (preserveTurns > 0) {
    for (let index = 0; index < indexed.roles.length; index++) {
      const role = indexed.roles[index];
      if (role === "user" || role === "assistant") {
        conversationIndexes.push(index);
      }
      if (role === "user") {
        userIndexes.push(index);
      }
    }
  }
  const boundaryStartIndex = userIndexes.at(-preserveTurns);
  const preservedIndexSet = new Set(
    boundaryStartIndex === undefined
      ? userIndexes
      : conversationIndexes.filter((index) => index >= boundaryStartIndex),
  );
  if (boundaryStartIndex === undefined) {
    for (let index = conversationIndexes.length - 1; index >= 0; index--) {
      preservedIndexSet.add(conversationIndexes[index]!);
      if (preservedIndexSet.size >= preserveTurns * 2) {
        break;
      }
    }
  }
  const preservedToolCallIds = new Set<string>();
  for (const index of preservedIndexSet) {
    const shell = indexed.shells[index]!;
    if (shell.role === "assistant") {
      for (const toolCall of extractToolCallsFromAssistant(shell)) {
        preservedToolCallIds.add(toolCall.id);
      }
    }
  }
  if (preservedToolCallIds.size > 0) {
    const preservedStartIndex = conversationIndexes.find((index) => preservedIndexSet.has(index))!;
    for (let index = preservedStartIndex; index < indexed.roles.length; index++) {
      const shell = indexed.shells[index]!;
      if (shell.role === "toolResult") {
        const id = extractToolResultId(shell);
        if (id && preservedToolCallIds.has(id)) {
          preservedIndexSet.add(index);
        }
      }
    }
  }
  const summarizedIndexes: number[] = [];
  const preservedIndexes: number[] = [];
  for (let index = 0; index < indexed.roles.length; index++) {
    (preservedIndexSet.has(index) ? preservedIndexes : summarizedIndexes).push(index);
  }
  return {
    summarized: selectIndexedMessages(indexed, summarizedIndexes),
    preserved: selectIndexedMessages(indexed, preservedIndexes),
  };
}
export function splitPreservedRecentTurnSource(params: {
  messages: SafeguardMessageSource;
  recentTurnsPreserve: number;
}): { summarizableMessages: SafeguardMessageSource; preservedMessages: SafeguardMessageSource } {
  const split = splitPreservedIndexes(indexSource(params.messages), params.recentTurnsPreserve);
  return {
    summarizableMessages: indexedSource(split.summarized),
    preservedMessages: indexedSource(split.preserved),
  };
}

export function splitPreservedRecentTurns(params: {
  messages: AgentMessage[];
  recentTurnsPreserve: number;
}) {
  const split = splitPreservedRecentTurnSource({
    ...params,
    messages: arraySafeguardSource(params.messages),
  });
  if (split.preservedMessages.length === 0) {
    return { summarizableMessages: params.messages, preservedMessages: [] };
  }
  return {
    summarizableMessages: sanitizeToolUseResultPairing(
      materializeSafeguardSource(split.summarizableMessages),
    ),
    preservedMessages: materializeSafeguardSource(split.preservedMessages),
  };
}

function formatNonTextPlaceholder(content: unknown): string | null {
  if (content == null || typeof content === "string") {
    return null;
  }
  if (!Array.isArray(content)) {
    return "[non-text content]";
  }
  const typeCounts = new Map<string, number>();
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typeRaw = (block as { type?: unknown }).type;
    const type = typeof typeRaw === "string" && typeRaw.trim().length > 0 ? typeRaw : "unknown";
    if (type === "text") {
      continue;
    }
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  }
  return typeCounts.size > 0
    ? `[non-text content: ${Array.from(typeCounts, ([type, count]) =>
        count > 1 ? `${type} x${count}` : type,
      ).join(", ")}]`
    : null;
}

function formatContextMessage(message: AgentMessage): string | null {
  let roleLabel: string;
  if (message.role === "assistant") {
    roleLabel = "Assistant";
  } else if (message.role === "user") {
    roleLabel = formatCompactionUserLabel(message);
  } else if (message.role === "toolResult") {
    const toolName = (message as { toolName?: unknown }).toolName;
    const safeToolName = typeof toolName === "string" && toolName.trim() ? toolName : "tool";
    roleLabel = `Tool result (${safeToolName})`;
  } else {
    return null;
  }
  const rendered = [
    extractMessageText(message),
    formatNonTextPlaceholder((message as { content?: unknown }).content),
  ]
    .filter(Boolean)
    .join("\n");
  if (!rendered) {
    return null;
  }
  // Tool output is bulk the summary already distills; keep only a head excerpt
  // so it cannot crowd generated facts out of the bounded artifact.
  const limit =
    message.role === "toolResult" ? MAX_PRESERVED_TOOL_RESULT_CHARS : MAX_RECENT_TURN_TEXT_CHARS;
  const trimmed =
    rendered.length <= limit
      ? rendered
      : message.role === "toolResult"
        ? `${truncateUtf16Safe(rendered, limit)} [${rendered.length - limit} more chars omitted at compaction]`
        : `${truncateUtf16Safe(rendered, limit)}...`;
  return `- ${roleLabel}: ${trimmed}`;
}

const NON_CALL_PAIRING_SHELL: AgentMessage = { role: "user", content: "", timestamp: 0 };

/** Retain only occurrence ownership while the snapshot supplies payloads on demand. */
function pairingShell(message: AgentMessage): AgentMessage {
  if (message.role === "toolResult") {
    const synthetic = isSyntheticMissingToolResult(message);
    return {
      role: "toolResult",
      toolCallId: extractToolResultId(message) ?? "",
      toolName: message.toolName,
      content: [],
      isError: synthetic,
      timestamp: 0,
      ...(synthetic ? { details: { [SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY]: true } } : {}),
    };
  }
  if (message.role === "assistant") {
    const calls = extractToolCallsFromAssistant(message);
    if (calls.length === 0) {
      return NON_CALL_PAIRING_SHELL;
    }
    return {
      role: "assistant",
      content: calls.map(({ id, name }) => ({
        type: "toolCall",
        id,
        name: name ?? "",
        arguments: {},
      })),
      api: "compaction-pairing",
      provider: "compaction-pairing",
      model: "",
      stopReason: message.stopReason,
      timestamp: 0,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
  }
  return NON_CALL_PAIRING_SHELL;
}

function formatBoundedContextSection(params: {
  indexed: IndexedMessages;
  heading: string;
  truncatedMarker: string;
  truncatedLoss: NonNullable<ContextSection["truncatedLoss"]>;
}): ContextSection {
  const { indexed } = params;
  const toolSegments = new Map(
    classifyToolUseResultPairing(indexed.shells).map((frame) => [
      frame.startIndex,
      frame.occurrences.flatMap((occurrence) =>
        occurrence.sourceResultIndex === undefined ? [] : [occurrence.sourceResultIndex],
      ),
    ]),
  );
  const messages = indexedSource(indexed);
  let prefix = `${params.heading}\n`;
  const segments: string[] = [];
  let chars = 0;
  let truncated = false;
  // The section keeps a contiguous tail of atomic interactions. Once an atom
  // overflows, no earlier payload can contribute; do not hydrate those rows.
  for (let index = indexed.roles.length - 1; index >= 0; index--) {
    if (indexed.roles[index] !== "user" && indexed.roles[index] !== "assistant") {
      continue;
    }
    const message = messages.get(index);
    if (!message) {
      continue;
    }
    const first = formatContextMessage(message);
    const lines = first ? [first] : [];
    let atomChars = first?.length ?? 0;
    for (const resultIndex of toolSegments.get(index) ?? []) {
      if (atomChars > MAX_SPLIT_TURN_CONTEXT_CHARS) {
        break;
      }
      const result = messages.get(resultIndex);
      const line = result ? formatContextMessage(result) : null;
      if (line) {
        atomChars += line.length + Number(lines.length > 0);
        lines.push(line);
      }
    }
    if (lines.length === 0) {
      continue;
    }
    const segment = lines.join("\n");
    const nextChars = chars + segment.length + Number(segments.length > 0);
    if (prefix.length + nextChars > MAX_SPLIT_TURN_CONTEXT_CHARS) {
      truncated = true;
      prefix += params.truncatedMarker;
      while (segments.length > 0 && prefix.length + chars > MAX_SPLIT_TURN_CONTEXT_CHARS) {
        chars -= segments.pop()!.length + Number(segments.length > 0);
      }
      break;
    }
    segments.push(segment);
    chars = nextChars;
  }
  if (!truncated && segments.length === 0) {
    return { text: "", segmentStarts: [] };
  }
  segments.reverse();
  let offset = prefix.length;
  return {
    text: `${prefix}${segments.join("\n")}`,
    segmentStarts: segments.map((segment) => {
      const start = offset;
      offset += segment.length + 1;
      return start;
    }),
    ...(truncated ? { truncatedLoss: params.truncatedLoss } : {}),
  };
}

function buildIndexedPreservedTurnsSection(indexed: IndexedMessages): ContextSection {
  return formatBoundedContextSection({
    indexed,
    heading: "\n\n## Recent turns preserved verbatim",
    truncatedMarker: PRESERVED_TURNS_TRUNCATED_MARKER,
    truncatedLoss: "preserved-turn-head",
  });
}

export function buildPreservedTurnsSectionFromSource(
  messages: SafeguardMessageSource,
): ContextSection {
  return buildIndexedPreservedTurnsSection(indexSource(messages));
}

export function buildSplitTurnContextSectionFromSource(
  messages: SafeguardMessageSource,
): ContextSection {
  return formatBoundedContextSection({
    indexed: indexSource(messages),
    heading: "**Turn Context (split turn):**\n",
    truncatedMarker: SPLIT_TURN_TRUNCATED_MARKER,
    truncatedLoss: "split-turn-head",
  });
}

export function buildPreservedTurnsSection(messages: AgentMessage[]): ContextSection {
  return buildPreservedTurnsSectionFromSource(arraySafeguardSource(messages));
}
export function buildSplitTurnContextSection(messages: AgentMessage[]): ContextSection {
  return buildSplitTurnContextSectionFromSource(arraySafeguardSource(messages));
}

function scanSafeguardMessages(
  historySource: SafeguardMessageSource,
  turnPrefixSource: SafeguardMessageSource,
) {
  const history = emptyIndex(historySource);
  const turnPrefix = emptyIndex(turnPrefixSource);
  const classify = createRealConversationClassifier();
  let hasRealConversation = false;
  function* messages() {
    for (const indexed of [history, turnPrefix]) {
      for (const message of indexMessages(indexed, true)) {
        hasRealConversation ||= classify(message);
        yield message;
      }
    }
  }
  const toolFailureSection = formatToolFailuresSection(collectToolFailures(messages()));
  return { history, turnPrefix, hasRealConversation, toolFailureSection };
}

/** Fuse transcript facts into one scan; later consumers revisit only selected text. */
export function prepareCompactionSafeguardSource(params: {
  history: SafeguardMessageSource;
  turnPrefix: SafeguardMessageSource;
  currentContext?: () => Iterable<AgentMessage>;
  preparationRange?: () => SafeguardMessageSource;
  isSplitTurn: boolean;
  previousSummary?: string;
  requestSelection?: { state: "unresolved"; request: string } | { state: "none" };
  latestUnresolvedUserRequest?: string;
  recentTurnsPreserve: number;
  qualityGuardEnabled: boolean;
}) {
  let scanned = scanSafeguardMessages(params.history, params.turnPrefix);
  let usedRangeFallback = false;
  if (!scanned.hasRealConversation && params.preparationRange) {
    const range = scanSafeguardMessages(params.preparationRange(), arraySafeguardSource([]));
    if (range.hasRealConversation) {
      scanned = range;
      usedRangeFallback = true;
    }
  }
  const { history: historyIndex, turnPrefix: turnPrefixIndex, toolFailureSection } = scanned;
  const history = indexedSource(historyIndex);
  const turnPrefix = indexedSource(turnPrefixIndex);
  const oracle = concatenateSources(history, turnPrefix);
  const hasRealConversation =
    scanned.hasRealConversation ||
    Boolean(params.currentContext && containsRealConversation(params.currentContext()));
  const latestPreparedAsk = currentUserAsk(historyIndex);
  const prefixAsk = currentUserAsk(turnPrefixIndex);
  const splitUserAsk = params.isSplitTurn ? prefixAsk : null;
  const latestUserAsk = params.requestSelection
    ? params.requestSelection.state === "unresolved"
      ? params.requestSelection.request
      : null
    : turnPrefixIndex.lastUserIndex >= 0
      ? prefixAsk
      : latestPreparedAsk;
  const latestAskInRetainedTurn = splitUserAsk !== null && splitUserAsk === latestUserAsk;
  const recentText: string[] = [];
  for (let index = Math.max(0, oracle.length - 10); index < oracle.length; index++) {
    const message = oracle.get(index);
    const text = message ? extractMessageText(message) : "";
    if (text) {
      recentText.push(text);
    }
  }
  const identifiers = extractOpaqueIdentifiers(recentText.join("\n"));
  const split = splitPreservedIndexes(historyIndex, params.recentTurnsPreserve);
  const preservedTurnsSection = buildIndexedPreservedTurnsSection(split.preserved);
  const requiredAskContext = formatRequiredAskContext(latestUserAsk ?? "");
  const includePreservedContext =
    !params.latestUnresolvedUserRequest &&
    params.qualityGuardEnabled &&
    latestPreparedAsk === latestUserAsk &&
    !preservedTurnsSection.text.includes(requiredAskContext);
  // The array path repairs the non-preserved slice. Count the same repaired
  // ownership shells; an orphan-only slice must not trigger another summary.
  const summarizableCount =
    split.preserved.indexes.length > 0
      ? sanitizeToolUseResultPairing(split.summarized.shells).length
      : split.summarized.indexes.length;
  const reconciliation =
    params.previousSummary ||
    includePreservedContext ||
    summarizableCount > 0 ||
    turnPrefix.length > 0
      ? oracle
      : arraySafeguardSource([]);
  return {
    history,
    turnPrefix,
    reconciliation,
    hasRealConversation,
    usedRangeFallback,
    toolFailureSection,
    preservedTurnsSection,
    identifiers,
    latestUserAsk,
    latestAskInRetainedTurn,
    requiredAskContext,
  };
}
