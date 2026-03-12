import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { sanitizeUserFacingText } from "./pi-embedded-helpers.js";
import {
  extractAssistantText,
  stripDowngradedToolCallText,
  stripModelSpecialTokens,
  stripMinimaxToolCallXml,
  stripThinkingTagsFromText,
} from "./pi-embedded-utils.js";

export type AssistantMessagePhase = "commentary" | "final_answer";

export type AssistantOutputEntry = {
  segmentId: string;
  text: string;
  phase?: AssistantMessagePhase | null;
};

type AssistantOutputCandidate = AssistantOutputEntry & {
  isTerminal: boolean;
};

type AssistantFallbackFingerprintState = {
  activeLiveMessageId?: string;
  messageIdsByOccurrence: string[];
};

export type AssistantOutputIdState = {
  fingerprintStates: Map<string, AssistantFallbackFingerprintState>;
  messageIdsByObject: WeakMap<object, string>;
  nextGeneratedMessageId: number;
};

export function createAssistantOutputIdState(): AssistantOutputIdState {
  // Keep fallback-id reuse scoped to a single run so identical unsigned messages
  // across unrelated conversations do not accumulate or collide globally.
  return {
    fingerprintStates: new Map(),
    messageIdsByObject: new WeakMap(),
    nextGeneratedMessageId: 0,
  };
}

export function normalizeAssistantMessagePhase(value: unknown): AssistantMessagePhase | null {
  return value === "commentary" || value === "final_answer" ? value : null;
}

function sanitizeAssistantSegmentText(text: string, errorContext: boolean) {
  return sanitizeUserFacingText(
    stripThinkingTagsFromText(
      stripDowngradedToolCallText(stripModelSpecialTokens(stripMinimaxToolCallXml(text))),
    ).trim(),
    { errorContext },
  );
}

function parseAssistantTextSignature(
  value: unknown,
): { id: string; phase?: AssistantMessagePhase } | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) {
    return { id: trimmed };
  }
  try {
    const parsed = JSON.parse(trimmed) as { id?: unknown; phase?: unknown };
    if (typeof parsed.id !== "string" || parsed.id.trim().length === 0) {
      return null;
    }
    const normalizedPhase = normalizeAssistantMessagePhase(parsed.phase);
    return {
      id: parsed.id,
      ...(normalizedPhase ? { phase: normalizedPhase } : {}),
    };
  } catch {
    return null;
  }
}

function resolveAssistantTextBlockPhase(
  block: Record<string, unknown>,
  defaultPhase?: AssistantMessagePhase | null,
) {
  const directPhase = normalizeAssistantMessagePhase(block.phase);
  if (directPhase) {
    return directPhase;
  }
  const parsedSignature = parseAssistantTextSignature(block.textSignature);
  if (parsedSignature?.phase) {
    return parsedSignature.phase;
  }
  return defaultPhase ?? null;
}

function resolveAssistantTextBlockSignatureId(block: Record<string, unknown>) {
  return parseAssistantTextSignature(block.textSignature)?.id;
}

function resolveAssistantMessageStableId(
  messageRecord?: Record<string, unknown>,
  fallbackMessageStableId?: string,
) {
  const id = messageRecord?.id;
  return typeof id === "string" && id.trim().length > 0
    ? id
    : (fallbackMessageStableId ?? "message");
}

function buildNextAssistantFallbackMessageId(state: AssistantOutputIdState) {
  const id = `stream-${state.nextGeneratedMessageId}`;
  state.nextGeneratedMessageId += 1;
  return id;
}

function getAssistantFallbackFingerprintState(state: AssistantOutputIdState, fingerprint: string) {
  const existingState = state.fingerprintStates.get(fingerprint);
  if (existingState) {
    return existingState;
  }
  const nextState: AssistantFallbackFingerprintState = {
    messageIdsByOccurrence: [],
  };
  state.fingerprintStates.set(fingerprint, nextState);
  return nextState;
}

function resolveLiveAssistantFallbackMessageId(
  message: AgentMessage,
  state: AssistantOutputIdState,
) {
  if (!message || typeof message !== "object") {
    return "stream";
  }
  const existingId = state.messageIdsByObject.get(message as object);
  if (existingId) {
    return existingId;
  }
  const fingerprint = buildAssistantFallbackFingerprint(message);
  const fingerprintState = getAssistantFallbackFingerprintState(state, fingerprint);
  if (fingerprintState.activeLiveMessageId) {
    // Live reconciliation only ever tracks the current in-flight assistant turn,
    // so reusing the active id for an equivalent replacement object is safe here.
    state.messageIdsByObject.set(message as object, fingerprintState.activeLiveMessageId);
    return fingerprintState.activeLiveMessageId;
  }
  const id = buildNextAssistantFallbackMessageId(state);
  fingerprintState.activeLiveMessageId = id;
  fingerprintState.messageIdsByOccurrence.push(id);
  state.messageIdsByObject.set(message as object, id);
  return id;
}

function buildAssistantFallbackFingerprint(message: AgentMessage) {
  return hashAssistantIdentityKey(
    JSON.stringify(
      buildComparableMessageRecord(message, {
        includeTimestamp: false,
        includeStopReason: false,
      }),
    ),
  );
}

function hashAssistantIdentityKey(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `stream-${(hash >>> 0).toString(36)}`;
}

function getAssistantFallbackFingerprint(message: AgentMessage) {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const messageRecord = message as unknown as Record<string, unknown>;
  if (typeof messageRecord.id === "string" && messageRecord.id.trim().length > 0) {
    return undefined;
  }
  return buildAssistantFallbackFingerprint(message);
}

function seedAssistantFallbackFingerprintOccurrences(
  messages: AgentMessage[],
  upToIndexExclusive: number,
) {
  const occurrences = new Map<string, number>();
  for (const message of messages.slice(0, upToIndexExclusive)) {
    if (message?.role !== "assistant") {
      continue;
    }
    const fingerprint = getAssistantFallbackFingerprint(message);
    if (!fingerprint) {
      continue;
    }
    occurrences.set(fingerprint, (occurrences.get(fingerprint) ?? 0) + 1);
  }
  return occurrences;
}

function recordAssistantFallbackFingerprintOccurrence(
  occurrences: Map<string, number>,
  fingerprint: string | undefined,
) {
  if (!fingerprint) {
    return undefined;
  }
  const occurrenceIndex = occurrences.get(fingerprint) ?? 0;
  occurrences.set(fingerprint, occurrenceIndex + 1);
  return occurrenceIndex;
}

function resolveFinalizedAssistantFallbackMessageId(params: {
  fingerprint: string;
  occurrenceIndex: number;
  state: AssistantOutputIdState;
}) {
  const fingerprintState = getAssistantFallbackFingerprintState(params.state, params.fingerprint);
  const existingId = fingerprintState.messageIdsByOccurrence[params.occurrenceIndex];
  if (existingId) {
    if (fingerprintState.activeLiveMessageId === existingId) {
      fingerprintState.activeLiveMessageId = undefined;
    }
    return existingId;
  }
  const id = buildNextAssistantFallbackMessageId(params.state);
  fingerprintState.messageIdsByOccurrence[params.occurrenceIndex] = id;
  return id;
}

function toOptionalTrimmedString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeAssistantContentForComparison(
  content: unknown,
  options?: { assistantDefaultPhase?: AssistantMessagePhase | null },
) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  return content.map((block) => {
    if (!block || typeof block !== "object") {
      return null;
    }
    const record = block as Record<string, unknown>;
    const type = toOptionalTrimmedString(record.type) ?? "unknown";
    if (type === "text") {
      return {
        type,
        text: typeof record.text === "string" ? record.text : "",
        phase: resolveAssistantTextBlockPhase(record, options?.assistantDefaultPhase) ?? null,
        textSignatureId: resolveAssistantTextBlockSignatureId(record) ?? null,
      };
    }
    if (type === "toolCall") {
      return {
        type,
        id: toOptionalTrimmedString(record.id ?? record.toolCallId) ?? null,
        name: toOptionalTrimmedString(record.name ?? record.toolName) ?? null,
        arguments:
          typeof record.arguments === "string"
            ? record.arguments
            : JSON.stringify(record.arguments ?? record.args ?? null),
      };
    }
    if (type === "thinking") {
      return {
        type,
        thinking: typeof record.thinking === "string" ? record.thinking : "",
        thinkingSignature: toOptionalTrimmedString(record.thinkingSignature) ?? null,
      };
    }
    return {
      type,
      id: toOptionalTrimmedString(record.id) ?? null,
      name: toOptionalTrimmedString(record.name) ?? null,
      text: typeof record.text === "string" ? record.text : null,
    };
  });
}

function buildComparableMessageRecord(
  message: AgentMessage,
  options?: { includeTimestamp?: boolean; includeStopReason?: boolean },
) {
  const messageRecord =
    message && typeof message === "object" ? (message as unknown as Record<string, unknown>) : {};
  const defaultPhase = normalizeAssistantMessagePhase(messageRecord.phase);
  return {
    role: toOptionalTrimmedString(messageRecord.role) ?? null,
    id: toOptionalTrimmedString(messageRecord.id) ?? null,
    api: toOptionalTrimmedString(messageRecord.api) ?? null,
    provider: toOptionalTrimmedString(messageRecord.provider) ?? null,
    model: toOptionalTrimmedString(messageRecord.model) ?? null,
    phase: defaultPhase ?? null,
    ...(options?.includeTimestamp && typeof messageRecord.timestamp === "number"
      ? { timestamp: messageRecord.timestamp }
      : {}),
    ...(options?.includeStopReason
      ? { stopReason: toOptionalTrimmedString(messageRecord.stopReason) ?? null }
      : {}),
    toolCallId: toOptionalTrimmedString(messageRecord.toolCallId) ?? null,
    toolUseId: toOptionalTrimmedString(messageRecord.toolUseId) ?? null,
    toolName: toOptionalTrimmedString(messageRecord.toolName) ?? null,
    isError: typeof messageRecord.isError === "boolean" ? messageRecord.isError : null,
    content: normalizeAssistantContentForComparison(messageRecord.content, {
      assistantDefaultPhase: defaultPhase,
    }),
  };
}

function extractAssistantOutputCandidates(
  msg: AgentMessage,
  options?: { fallbackMessageStableId?: string },
): AssistantOutputCandidate[] {
  const messageRecord =
    msg && typeof msg === "object" ? (msg as unknown as Record<string, unknown>) : undefined;
  const messageStableId = resolveAssistantMessageStableId(
    messageRecord,
    options?.fallbackMessageStableId,
  );
  const defaultPhase = normalizeAssistantMessagePhase(messageRecord?.phase);
  const errorContext = messageRecord?.stopReason === "error";
  const content = Array.isArray(messageRecord?.content)
    ? (messageRecord.content as Array<Record<string, unknown>>)
    : null;

  if (!content) {
    const text = extractAssistantText(msg as AssistantMessage);
    return text
      ? [
          {
            segmentId: `assistant:${messageStableId}:segment:0`,
            text,
            isTerminal: true,
            ...(defaultPhase ? { phase: defaultPhase } : {}),
          },
        ]
      : [];
  }

  const groupedSegments: AssistantOutputCandidate[] = [];
  let pendingUnsignedSegment: AssistantOutputCandidate | null = null;
  let unsignedSegmentOrdinal = 0;
  const flushPendingUnsignedSegment = () => {
    if (!pendingUnsignedSegment) {
      return;
    }
    groupedSegments.push(pendingUnsignedSegment);
    pendingUnsignedSegment = null;
  };
  for (const [index, block] of content.entries()) {
    if (block.type !== "text" || typeof block.text !== "string") {
      flushPendingUnsignedSegment();
      continue;
    }
    const phase = resolveAssistantTextBlockPhase(block, defaultPhase);
    const signatureId = resolveAssistantTextBlockSignatureId(block);
    if (signatureId) {
      flushPendingUnsignedSegment();
      groupedSegments.push({
        segmentId: signatureId,
        text: block.text,
        isTerminal: index === content.length - 1,
        ...(phase ? { phase } : {}),
      });
      continue;
    }
    if (!pendingUnsignedSegment || (pendingUnsignedSegment.phase ?? null) !== (phase ?? null)) {
      flushPendingUnsignedSegment();
      pendingUnsignedSegment = {
        segmentId: `assistant:${messageStableId}:segment:${unsignedSegmentOrdinal}`,
        text: block.text,
        isTerminal: index === content.length - 1,
        ...(phase ? { phase } : {}),
      };
      unsignedSegmentOrdinal += 1;
      continue;
    }
    pendingUnsignedSegment.text += block.text;
    pendingUnsignedSegment.isTerminal = index === content.length - 1;
  }
  flushPendingUnsignedSegment();

  return groupedSegments
    .map<AssistantOutputCandidate | null>((segment) => {
      const text = sanitizeAssistantSegmentText(segment.text, errorContext).trim();
      return text
        ? {
            segmentId: segment.segmentId,
            text,
            isTerminal: segment.isTerminal,
            ...(segment.phase ? { phase: segment.phase } : {}),
          }
        : null;
    })
    .filter((segment): segment is AssistantOutputCandidate => Boolean(segment));
}

export function extractAssistantOutputSegments(
  msg: AgentMessage,
  options?: { fallbackMessageStableId?: string },
): AssistantOutputEntry[] {
  return extractAssistantOutputCandidates(msg, options).map(
    ({ isTerminal: _isTerminal, ...segment }) => {
      return segment;
    },
  );
}

export async function reconcileLiveAssistantCommentary(params: {
  idState?: AssistantOutputIdState;
  message: AgentMessage | null | undefined;
  seenSegmentIds: Set<string>;
  onCommentary?: (segment: AssistantOutputEntry) => void | Promise<void>;
}) {
  if (!params.message || params.message.role !== "assistant") {
    return { newOutputs: [] as AssistantOutputEntry[] };
  }

  const idState = params.idState ?? createAssistantOutputIdState();
  const liveFallbackMessageId = resolveLiveAssistantFallbackMessageId(params.message, idState);

  const newOutputs: AssistantOutputEntry[] = [];
  for (const segment of extractAssistantOutputCandidates(params.message, {
    fallbackMessageStableId: liveFallbackMessageId,
  })) {
    if (
      segment.phase !== "commentary" ||
      segment.isTerminal ||
      params.seenSegmentIds.has(segment.segmentId)
    ) {
      continue;
    }
    params.seenSegmentIds.add(segment.segmentId);
    const { isTerminal: _isTerminal, ...resolvedSegment } = segment;
    newOutputs.push(resolvedSegment);
    await params.onCommentary?.(resolvedSegment);
  }

  return { newOutputs };
}

export async function reconcileAssistantOutputs(params: {
  idState?: AssistantOutputIdState;
  messages: AgentMessage[];
  startIndex: number;
  seenSegmentIds: Set<string>;
  historyBeforePrompt?: AgentMessage[];
}) {
  const newOutputs: AssistantOutputEntry[] = [];
  const idState = params.idState ?? createAssistantOutputIdState();
  const recoveredPromptBoundaryIndex =
    params.historyBeforePrompt && params.historyBeforePrompt.length > 0
      ? resolveCompactedPromptBoundaryIndex(params.messages, params.historyBeforePrompt)
      : undefined;
  const candidateStartIndex =
    params.startIndex >= 0 && params.startIndex <= params.messages.length
      ? params.startIndex
      : (recoveredPromptBoundaryIndex ?? 0);
  const normalizedStartIndex =
    typeof recoveredPromptBoundaryIndex === "number"
      ? Math.min(candidateStartIndex, recoveredPromptBoundaryIndex)
      : candidateStartIndex;
  const fallbackFingerprintOccurrences = seedAssistantFallbackFingerprintOccurrences(
    params.messages,
    normalizedStartIndex,
  );
  let nextStartIndex = params.messages.length;

  for (const [index, msg] of params.messages.slice(normalizedStartIndex).entries()) {
    const absoluteIndex = normalizedStartIndex + index;
    if (msg?.role !== "assistant") {
      continue;
    }
    const messageRecord =
      msg && typeof msg === "object" ? (msg as unknown as Record<string, unknown>) : undefined;
    if (typeof messageRecord?.stopReason !== "string" || messageRecord.stopReason.trim() === "") {
      nextStartIndex = absoluteIndex;
      break;
    }
    const fallbackFingerprint = getAssistantFallbackFingerprint(msg);
    const fallbackOccurrenceIndex = recordAssistantFallbackFingerprintOccurrence(
      fallbackFingerprintOccurrences,
      fallbackFingerprint,
    );
    for (const segment of extractAssistantOutputSegments(msg, {
      fallbackMessageStableId:
        fallbackFingerprint && typeof fallbackOccurrenceIndex === "number"
          ? resolveFinalizedAssistantFallbackMessageId({
              fingerprint: fallbackFingerprint,
              occurrenceIndex: fallbackOccurrenceIndex,
              state: idState,
            })
          : undefined,
    })) {
      if (params.seenSegmentIds.has(segment.segmentId)) {
        continue;
      }
      params.seenSegmentIds.add(segment.segmentId);
      newOutputs.push(segment);
    }
  }

  return { newOutputs, nextStartIndex };
}

function resolveCompactedPromptBoundaryIndex(
  messages: AgentMessage[],
  historyBeforePrompt?: AgentMessage[],
) {
  if (!historyBeforePrompt || historyBeforePrompt.length === 0 || messages.length === 0) {
    return undefined;
  }

  const maxRetainedPrefixLength = Math.min(historyBeforePrompt.length, messages.length);
  for (
    let retainedPrefixLength = maxRetainedPrefixLength;
    retainedPrefixLength > 0;
    retainedPrefixLength -= 1
  ) {
    const historyStartIndex = historyBeforePrompt.length - retainedPrefixLength;
    let matchesRetainedPrefix = true;
    for (let index = 0; index < retainedPrefixLength; index += 1) {
      const beforePromptMessage = historyBeforePrompt[historyStartIndex + index];
      const currentMessage = messages[index];
      if (!assistantHistoryMessagesMatch(beforePromptMessage, currentMessage)) {
        matchesRetainedPrefix = false;
        break;
      }
    }
    if (matchesRetainedPrefix) {
      return retainedPrefixLength;
    }
  }

  return undefined;
}

function assistantHistoryMessagesMatch(
  left: AgentMessage | undefined,
  right: AgentMessage | undefined,
) {
  if (left === right) {
    return true;
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  try {
    return (
      JSON.stringify(
        buildComparableMessageRecord(left, {
          includeStopReason: true,
        }),
      ) ===
      JSON.stringify(
        buildComparableMessageRecord(right, {
          includeStopReason: true,
        }),
      )
    );
  } catch {
    return false;
  }
}
