import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { sanitizeUserFacingText } from "./pi-embedded-helpers.js";
import {
  extractAssistantText,
  stripDowngradedToolCallText,
  stripMinimaxToolCallXml,
  stripModelSpecialTokens,
  stripThinkingTagsFromText,
} from "./pi-embedded-utils.js";

export type AssistantMessagePhase = "commentary" | "final_answer";

export type AssistantOutputEntry = {
  segmentId: string;
  text: string;
  phase?: AssistantMessagePhase | null;
};

export type AssistantOutputCandidate = AssistantOutputEntry & {
  isTerminal: boolean;
};

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

export function extractAssistantOutputCandidates(
  msg: AgentMessage,
  options?: { fallbackMessageStableId?: string },
): AssistantOutputCandidate[] {
  if (msg?.role !== "assistant") {
    return [];
  }
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
    const text = extractAssistantText(msg);
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
