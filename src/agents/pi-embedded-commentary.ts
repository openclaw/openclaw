import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  normalizeAssistantPhase,
  parseAssistantTextSignature,
  type AssistantPhase,
} from "../shared/chat-message-content.js";
import { sanitizeUserFacingText } from "./pi-embedded-helpers.js";
import {
  extractAssistantText,
  stripDowngradedToolCallText,
  stripMinimaxToolCallXml,
  stripModelSpecialTokens,
  stripThinkingTagsFromText,
} from "./pi-embedded-utils.js";

export type AssistantMessagePhase = AssistantPhase;

export type AssistantOutputEntry = {
  segmentId: string;
  text: string;
  phase?: AssistantMessagePhase | null;
};

export type AssistantOutputCandidate = AssistantOutputEntry & {
  isTerminal: boolean;
};

export const MAX_ASSISTANT_COMMENTARY_SEGMENT_ID_LENGTH = 128;
const ASSISTANT_COMMENTARY_SEGMENT_ID_RE = /^[A-Za-z0-9._:@/-]+$/;

export function resolveAssistantCommentaryDeltaText(params: {
  currentText: string;
  deliveredText?: string;
  deliveredTextLength?: number;
}): string | null {
  const { currentText, deliveredText } = params;
  if (!deliveredText) {
    return currentText;
  }
  if (currentText === deliveredText) {
    return null;
  }
  const safeDeliveredLength =
    params.deliveredTextLength !== undefined && params.deliveredTextLength <= deliveredText.length
      ? params.deliveredTextLength
      : deliveredText.length;
  if (currentText.startsWith(deliveredText)) {
    if (currentText.length <= safeDeliveredLength) {
      return null;
    }
    const deltaText = currentText.slice(safeDeliveredLength);
    return deltaText.length > 0 ? deltaText : null;
  }
  if (deliveredText.startsWith(currentText)) {
    return null;
  }
  return currentText;
}

export function normalizeAssistantMessagePhase(value: unknown): AssistantMessagePhase | null {
  return normalizeAssistantPhase(value) ?? null;
}

export function normalizeAssistantOutputSegmentId(value: string): string | null {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_ASSISTANT_COMMENTARY_SEGMENT_ID_LENGTH ||
    !ASSISTANT_COMMENTARY_SEGMENT_ID_RE.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function sanitizeAssistantSegmentText(text: string, errorContext: boolean) {
  return sanitizeUserFacingText(
    stripThinkingTagsFromText(
      stripDowngradedToolCallText(stripModelSpecialTokens(stripMinimaxToolCallXml(text))),
    ).trim(),
    { errorContext },
  );
}

function parseNormalizedAssistantTextSignature(
  value: unknown,
): { id?: string; phase?: AssistantMessagePhase } | null {
  let parsed = parseAssistantTextSignature(value);
  if (!parsed && typeof value === "string" && value.trim().startsWith("{")) {
    try {
      const legacy = JSON.parse(value.trim()) as { id?: unknown; phase?: unknown };
      parsed = {
        ...(typeof legacy.id === "string" ? { id: legacy.id } : {}),
        ...(normalizeAssistantMessagePhase(legacy.phase)
          ? { phase: normalizeAssistantMessagePhase(legacy.phase) ?? undefined }
          : {}),
      };
    } catch {
      parsed = null;
    }
  }
  if (!parsed) {
    return null;
  }
  const normalizedId =
    typeof parsed.id === "string" ? normalizeAssistantOutputSegmentId(parsed.id) : null;
  const phase = normalizeAssistantMessagePhase(parsed.phase);
  if (!normalizedId && !phase) {
    return null;
  }
  return {
    ...(normalizedId ? { id: normalizedId } : {}),
    ...(phase ? { phase } : {}),
  };
}

function resolveAssistantTextBlockPhase(
  block: Record<string, unknown>,
  defaultPhase?: AssistantMessagePhase | null,
) {
  const directPhase = normalizeAssistantMessagePhase(block.phase);
  if (directPhase) {
    return directPhase;
  }
  const parsedSignature = parseNormalizedAssistantTextSignature(block.textSignature);
  if (parsedSignature?.phase) {
    return parsedSignature.phase;
  }
  return defaultPhase ?? null;
}

function resolveAssistantTextBlockSignatureId(block: Record<string, unknown>) {
  return parseNormalizedAssistantTextSignature(block.textSignature)?.id;
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
  const content = Array.isArray(messageRecord?.content) ? messageRecord.content : null;

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
  const signedSegmentsByKey = new Map<string, AssistantOutputCandidate>();
  let pendingUnsignedSegment: AssistantOutputCandidate | null = null;
  let unsignedSegmentOrdinal = 0;

  const flushPendingUnsignedSegment = () => {
    if (!pendingUnsignedSegment) {
      return;
    }
    groupedSegments.push(pendingUnsignedSegment);
    pendingUnsignedSegment = null;
  };

  for (const [index, rawBlock] of content.entries()) {
    if (!rawBlock || typeof rawBlock !== "object") {
      flushPendingUnsignedSegment();
      continue;
    }
    const block = rawBlock as Record<string, unknown>;
    if (block.type !== "text" || typeof block.text !== "string") {
      flushPendingUnsignedSegment();
      continue;
    }
    const phase = resolveAssistantTextBlockPhase(block, defaultPhase);
    const signatureId = resolveAssistantTextBlockSignatureId(block);
    if (signatureId) {
      flushPendingUnsignedSegment();
      const signatureKey = `${signatureId}\u0000${phase ?? ""}`;
      const existingSegment = signedSegmentsByKey.get(signatureKey);
      if (existingSegment) {
        existingSegment.text += block.text;
        existingSegment.isTerminal = index === content.length - 1;
        continue;
      }
      const signedSegment: AssistantOutputCandidate = {
        segmentId: signatureId,
        text: block.text,
        isTerminal: index === content.length - 1,
        ...(phase ? { phase } : {}),
      };
      groupedSegments.push(signedSegment);
      signedSegmentsByKey.set(signatureKey, signedSegment);
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
      if (!text) {
        return null;
      }
      const candidate: AssistantOutputCandidate = {
        segmentId: segment.segmentId,
        text,
        isTerminal: segment.isTerminal,
      };
      if (segment.phase) {
        candidate.phase = segment.phase;
      }
      return candidate;
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
