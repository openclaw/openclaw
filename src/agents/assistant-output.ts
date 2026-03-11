import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { sanitizeUserFacingText } from "./pi-embedded-helpers.js";
import {
  extractAssistantText,
  stripDowngradedToolCallText,
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

const liveAssistantFallbackMessageIds = new WeakMap<object, string>();
let nextLiveAssistantFallbackMessageId = 0;

export function normalizeAssistantMessagePhase(value: unknown): AssistantMessagePhase | null {
  return value === "commentary" || value === "final_answer" ? value : null;
}

function sanitizeAssistantSegmentText(text: string, errorContext: boolean) {
  return sanitizeUserFacingText(
    stripThinkingTagsFromText(stripDowngradedToolCallText(stripMinimaxToolCallXml(text))).trim(),
    { errorContext },
  );
}

function resolveAssistantTextBlockPhase(
  block: Record<string, unknown>,
  defaultPhase?: AssistantMessagePhase | null,
) {
  const directPhase = normalizeAssistantMessagePhase(block.phase);
  if (directPhase) {
    return directPhase;
  }
  const signature = block.textSignature;
  if (typeof signature === "string" && signature.trim().length > 0) {
    try {
      const parsed = JSON.parse(signature) as { phase?: unknown };
      const signaturePhase = normalizeAssistantMessagePhase(parsed.phase);
      if (signaturePhase) {
        return signaturePhase;
      }
    } catch {
      // Ignore malformed signatures and fall back to the message-level phase.
    }
  }
  return defaultPhase ?? null;
}

function resolveAssistantTextBlockSignatureId(block: Record<string, unknown>) {
  const signature = block.textSignature;
  if (typeof signature !== "string" || signature.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(signature) as { id?: unknown };
    return typeof parsed.id === "string" && parsed.id.trim().length > 0 ? parsed.id : undefined;
  } catch {
    return undefined;
  }
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

function resolveLiveAssistantFallbackMessageId(message: AgentMessage) {
  if (!message || typeof message !== "object") {
    return "stream";
  }
  const existingId = liveAssistantFallbackMessageIds.get(message as object);
  if (existingId) {
    return existingId;
  }
  const id = `stream-${nextLiveAssistantFallbackMessageId}`;
  nextLiveAssistantFallbackMessageId += 1;
  liveAssistantFallbackMessageIds.set(message as object, id);
  return id;
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
  const errorContext =
    messageRecord?.stopReason === "error" ||
    (typeof messageRecord?.errorMessage === "string" &&
      messageRecord.errorMessage.trim().length > 0);
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

  const groupedSegments: Array<AssistantOutputCandidate & { signatureIds?: string[] }> = [];
  for (const [index, block] of content.entries()) {
    if (block.type !== "text" || typeof block.text !== "string") {
      continue;
    }
    const phase = resolveAssistantTextBlockPhase(block, defaultPhase);
    const signatureId = resolveAssistantTextBlockSignatureId(block);
    const lastGroup = groupedSegments.at(-1);
    if (!lastGroup || (lastGroup.phase ?? null) !== (phase ?? null)) {
      groupedSegments.push({
        segmentId: signatureId ?? `assistant:${messageStableId}:segment:${groupedSegments.length}`,
        text: block.text,
        isTerminal: index === content.length - 1,
        ...(phase ? { phase } : {}),
        ...(signatureId ? { signatureIds: [signatureId] } : {}),
      });
      continue;
    }
    lastGroup.text += block.text;
    lastGroup.isTerminal = index === content.length - 1;
    if (signatureId) {
      lastGroup.signatureIds = [...(lastGroup.signatureIds ?? []), signatureId];
      lastGroup.segmentId = lastGroup.signatureIds.join(",");
    } else if (!lastGroup.segmentId) {
      lastGroup.segmentId = `assistant:${messageStableId}:segment:${index}`;
    }
  }

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
  message: AgentMessage | null | undefined;
  seenSegmentIds: Set<string>;
  onCommentary?: (segment: AssistantOutputEntry) => void | Promise<void>;
}) {
  if (!params.message || params.message.role !== "assistant") {
    return { newOutputs: [] as AssistantOutputEntry[] };
  }

  const liveFallbackMessageId = resolveLiveAssistantFallbackMessageId(params.message);

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
  messages: AgentMessage[];
  startIndex: number;
  seenSegmentIds: Set<string>;
}) {
  const newOutputs: AssistantOutputEntry[] = [];
  const normalizedStartIndex =
    params.startIndex >= 0 && params.startIndex <= params.messages.length ? params.startIndex : 0;
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
    for (const segment of extractAssistantOutputSegments(msg, {
      fallbackMessageStableId: resolveLiveAssistantFallbackMessageId(msg),
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
