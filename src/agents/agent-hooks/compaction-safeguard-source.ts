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
import type { PreparedConversationMessage } from "../../../packages/agent-core/src/harness/compaction/utils.js";
import {
  classifyToolUseResultPairing,
  extractToolCallsFromAssistant,
  extractToolResultId,
} from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import {
  createRealConversationClassifier,
  createRealConversationFactClassifier,
  prepareRealConversationFacts,
} from "../compaction-real-conversation.js";
import { isOpenClawRuntimeContextCustomMessage } from "../internal-runtime-context.js";
import type { AgentMessage } from "../runtime/index.js";
import { sanitizeToolUseResultPairing } from "../session-transcript-repair.js";
import type { ContextSection } from "../sessions/prepared-compaction.types.js";
import { extractOpaqueIdentifiers } from "./compaction-safeguard-quality.js";
import {
  collectToolFailures,
  formatToolFailuresSection,
} from "./compaction-safeguard-tool-failures.js";

export interface SafeguardMessageSource {
  readonly length: number;
  get(index: number): AgentMessage | undefined;
  facts(index: number): SafeguardMessageFacts | undefined;
}
/** Worker callers supply navigation shells; array callers reuse their already-owned messages. */
export function prepareSafeguardMessage(
  message: AgentMessage,
  serialization?: PreparedConversationMessage,
  shell = message,
) {
  return {
    role: message.role,
    runtimeContext: isOpenClawRuntimeContextCustomMessage(message),
    shell,
    conversation: prepareRealConversationFacts(message),
    failure: collectToolFailures([message])[0],
    serialization,
  };
}
export type SafeguardMessageFacts = ReturnType<typeof prepareSafeguardMessage>;
const MAX_SPLIT_TURN_CONTEXT_CHARS = Math.floor(MAX_COMPACTION_SUMMARY_CHARS / 2);
const SPLIT_TURN_TRUNCATED_MARKER = "[Earlier split-turn messages truncated]\n";
const PRESERVED_TURNS_TRUNCATED_MARKER = "[Earlier preserved messages truncated]\n";
const MAX_RECENT_TURN_TEXT_CHARS = 600;
const MAX_PRESERVED_TOOL_RESULT_CHARS = 160;

export function arraySafeguardSource(messages: AgentMessage[]): SafeguardMessageSource {
  const facts = messages.map((message) => prepareSafeguardMessage(message));
  return {
    length: messages.length,
    get: (index) => messages[index],
    facts: (index) => facts[index],
  };
}
function selectSource(
  source: SafeguardMessageSource,
  indexes = Array.from({ length: source.length }, (_, index) => index).filter((index) =>
    source.facts(index),
  ),
): SafeguardMessageSource {
  if (indexes.length === source.length) {
    return source;
  }
  return {
    length: indexes.length,
    get: (index) => (indexes[index] === undefined ? undefined : source.get(indexes[index])),
    facts: (index) => (indexes[index] === undefined ? undefined : source.facts(indexes[index])),
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
function sourceShells(source: SafeguardMessageSource): AgentMessage[] {
  return Array.from({ length: source.length }, (_, index) => source.facts(index)!.shell);
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
    facts: (index) =>
      index < first.length ? first.facts(index) : second.facts(index - first.length),
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
/** Undefined means no input; null means an independent input with no external-user ask. */
function currentUserAsk(source: SafeguardMessageSource): string | null | undefined {
  for (let index = source.length - 1; index >= 0; index--) {
    if (source.facts(index)?.role === "user") {
      const message = source.get(index);
      return message ? extractCurrentCompactionUserRequest([message], extractMessageText) : null;
    }
  }
  return undefined;
}
export function splitPreservedRecentTurnSource(params: {
  messages: SafeguardMessageSource;
  recentTurnsPreserve: number;
}): { summarizableMessages: SafeguardMessageSource; preservedMessages: SafeguardMessageSource } {
  const messages = selectSource(params.messages);
  const preserveTurns = params.recentTurnsPreserve;
  const conversationIndexes = Array.from({ length: messages.length }, (_, index) => index).filter(
    (index) => preserveTurns > 0 && ["user", "assistant"].includes(messages.facts(index)!.role),
  );
  const userIndexes = conversationIndexes.filter((index) => messages.facts(index)!.role === "user");
  const boundaryStartIndex = userIndexes.at(-preserveTurns);
  const preserved = new Set(
    boundaryStartIndex === undefined
      ? userIndexes
      : conversationIndexes.filter((index) => index >= boundaryStartIndex),
  );
  if (boundaryStartIndex === undefined) {
    for (let index = conversationIndexes.length - 1; index >= 0; index--) {
      preserved.add(conversationIndexes[index]!);
      if (preserved.size >= preserveTurns * 2) {
        break;
      }
    }
  }
  const toolCallIds = new Set<string>();
  for (const index of preserved) {
    const message = messages.facts(index)!.shell;
    if (message.role === "assistant") {
      for (const call of extractToolCallsFromAssistant(message)) {
        toolCallIds.add(call.id);
      }
    }
  }
  if (toolCallIds.size > 0) {
    const start = conversationIndexes.find((index) => preserved.has(index))!;
    for (let index = start; index < messages.length; index++) {
      const message = messages.facts(index)!.shell;
      const id = message.role === "toolResult" ? extractToolResultId(message) : undefined;
      if (id && toolCallIds.has(id)) {
        preserved.add(index);
      }
    }
  }
  const summarizedIndexes: number[] = [];
  const preservedIndexes: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    (preserved.has(index) ? preservedIndexes : summarizedIndexes).push(index);
  }
  return {
    summarizableMessages: selectSource(messages, summarizedIndexes),
    preservedMessages: selectSource(messages, preservedIndexes),
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

function formatNonTextPlaceholder(
  content: Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }>["content"],
): string | null {
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
    const typeRaw = block.type;
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
    const toolName = message.toolName;
    const safeToolName = typeof toolName === "string" && toolName.trim() ? toolName : "tool";
    roleLabel = `Tool result (${safeToolName})`;
  } else {
    return null;
  }
  const rendered = [extractMessageText(message), formatNonTextPlaceholder(message.content)]
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

function formatBoundedContextSection(params: {
  messages: SafeguardMessageSource;
  heading: string;
  truncatedMarker: string;
  truncatedLoss: NonNullable<ContextSection["truncatedLoss"]>;
  maxChars: number;
}): ContextSection {
  const messages = selectSource(params.messages);
  const toolSegments = new Map(
    classifyToolUseResultPairing(sourceShells(messages)).map((frame) => [
      frame.startIndex,
      frame.occurrences.flatMap((occurrence) =>
        occurrence.sourceResultIndex === undefined ? [] : [occurrence.sourceResultIndex],
      ),
    ]),
  );
  let prefix = `${params.heading}\n`;
  const segments: string[] = [];
  let chars = 0;
  let truncated = false;
  // The section keeps a contiguous tail of atomic interactions. Once an atom
  // overflows, no earlier payload can contribute; do not hydrate those rows.
  for (let index = messages.length - 1; index >= 0; index--) {
    const role = messages.facts(index)!.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const lines: string[] = [];
    let atomChars = 0;
    for (const resultIndex of [index, ...(toolSegments.get(index) ?? [])]) {
      if (atomChars > params.maxChars) {
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
    if (prefix.length + nextChars > params.maxChars) {
      truncated = true;
      prefix += params.truncatedMarker;
      while (segments.length > 0 && prefix.length + chars > params.maxChars) {
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

export function buildPreservedTurnsSectionFromSource(
  messages: SafeguardMessageSource,
  maxChars = MAX_SPLIT_TURN_CONTEXT_CHARS,
): ContextSection {
  return formatBoundedContextSection({
    maxChars,
    messages,
    heading: "\n\n## Recent turns preserved verbatim",
    truncatedMarker: PRESERVED_TURNS_TRUNCATED_MARKER,
    truncatedLoss: "preserved-turn-head",
  });
}

export function buildSplitTurnContextSectionFromSource(
  messages: SafeguardMessageSource,
  maxChars = MAX_SPLIT_TURN_CONTEXT_CHARS,
): ContextSection {
  return formatBoundedContextSection({
    maxChars,
    messages,
    heading: "**Turn Context (split turn):**\n",
    truncatedMarker: SPLIT_TURN_TRUNCATED_MARKER,
    truncatedLoss: "split-turn-head",
  });
}

export function buildPreservedTurnsSection(
  messages: AgentMessage[],
  maxChars = MAX_SPLIT_TURN_CONTEXT_CHARS,
): ContextSection {
  return buildPreservedTurnsSectionFromSource(arraySafeguardSource(messages), maxChars);
}
export function buildSplitTurnContextSection(
  messages: AgentMessage[],
  maxChars = MAX_SPLIT_TURN_CONTEXT_CHARS,
): ContextSection {
  return buildSplitTurnContextSectionFromSource(arraySafeguardSource(messages), maxChars);
}

function scanSafeguardMessages(
  historySource: SafeguardMessageSource,
  turnPrefixSource: SafeguardMessageSource,
) {
  const classify = createRealConversationFactClassifier();
  let hasRealConversation = false;
  const failures: ReturnType<typeof collectToolFailures> = [];
  const seen = new Set<string>();
  const [history, turnPrefix] = [historySource, turnPrefixSource].map((source) => {
    const indexes: number[] = [];
    for (let index = 0; index < source.length; index++) {
      const facts = source.facts(index);
      if (!facts || facts.runtimeContext) {
        continue;
      }
      indexes.push(index);
      hasRealConversation = classify(facts.conversation) || hasRealConversation;
      if (facts.failure && !seen.has(facts.failure.toolCallId)) {
        seen.add(facts.failure.toolCallId);
        failures.push(facts.failure);
      }
    }
    return selectSource(source, indexes);
  });
  const toolFailureSection = formatToolFailuresSection(failures);
  return { history: history!, turnPrefix: turnPrefix!, hasRealConversation, toolFailureSection };
}

/** Fuse transcript facts into one scan; later consumers revisit only selected text. */
export function prepareCompactionSafeguardSource(params: {
  history: SafeguardMessageSource;
  turnPrefix: SafeguardMessageSource;
  currentContext?: () => Iterable<AgentMessage>;
  currentContextHasRealConversation?: boolean;
  preparationRange?: () => SafeguardMessageSource;
  isSplitTurn: boolean;
  previousSummary?: string;
  requestSelection?: { state: "unresolved"; request: string } | { state: "none" };
  latestUnresolvedUserRequest?: string;
  recentTurnsPreserve: number;
  qualityGuardEnabled: boolean;
  maxSummaryChars?: number;
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
  const { history, turnPrefix, toolFailureSection } = scanned;
  const oracle = concatenateSources(history, turnPrefix);
  const hasRealConversation =
    scanned.hasRealConversation ||
    params.currentContextHasRealConversation === true ||
    Boolean(params.currentContext && containsRealConversation(params.currentContext()));
  const latestPreparedAsk = currentUserAsk(history) ?? null;
  const prefixAsk = currentUserAsk(turnPrefix);
  const splitUserAsk = params.isSplitTurn ? (prefixAsk ?? null) : null;
  const latestUserAsk = params.requestSelection
    ? params.requestSelection.state === "unresolved"
      ? params.requestSelection.request
      : null
    : prefixAsk === undefined
      ? latestPreparedAsk
      : prefixAsk;
  const latestAskInRetainedTurn = splitUserAsk !== null && splitUserAsk === latestUserAsk;
  const identifiers = extractOpaqueIdentifiers(
    (function* () {
      for (let index = Math.max(0, oracle.length - 10); index < oracle.length; index++) {
        const message = oracle.get(index);
        if (message) {
          yield extractMessageText(message);
        }
      }
    })(),
  );
  const split = splitPreservedRecentTurnSource({
    messages: history,
    recentTurnsPreserve: params.recentTurnsPreserve,
  });
  const preservedTurnsSection = buildPreservedTurnsSectionFromSource(
    split.preservedMessages,
    Math.floor((params.maxSummaryChars ?? MAX_COMPACTION_SUMMARY_CHARS) / 2),
  );
  const requiredAskContext = formatRequiredAskContext(latestUserAsk ?? "");
  const includePreservedContext =
    !params.latestUnresolvedUserRequest &&
    params.qualityGuardEnabled &&
    latestPreparedAsk === latestUserAsk &&
    !preservedTurnsSection.text.includes(requiredAskContext);
  // The array path repairs the non-preserved slice. Count the same repaired
  // ownership shells; an orphan-only slice must not trigger another summary.
  const summarizableCount =
    split.preservedMessages.length > 0
      ? sanitizeToolUseResultPairing(sourceShells(split.summarizableMessages)).length
      : split.summarizableMessages.length;
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
