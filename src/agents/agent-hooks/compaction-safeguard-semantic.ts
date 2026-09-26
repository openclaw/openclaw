import { createHash } from "node:crypto";
import { classifyToolUseResultPairing } from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import type { AgentMessage } from "../runtime/index.js";

const MAX_SEGMENT_TEXT_CHARS = 6_000;
const MAX_OBLIGATION_TEXT_CHARS = 6_000;

type CompactionSemanticProtectionReason =
  | "user-authored"
  | "recent-turn"
  | "turn-prefix"
  | "obligation-source"
  | "exact-identifier"
  | "unpaired-tool-result"
  | "unsupported-content"
  | "oversized-segment";

type CompactionSemanticSegment = {
  id: string;
  sourceIndexes: number[];
  roles: string[];
  text: string;
  originalChars: number;
  protected: boolean;
  protectionReasons: CompactionSemanticProtectionReason[];
};

type CompactionSemanticObligation = {
  id: string;
  kind: "unresolved-request" | "latest-user-ask";
  text: string;
  sourceSegmentId?: string;
  complete: boolean;
};

export type CompactionSemanticSnapshot = {
  sourceFingerprint: string;
  segments: CompactionSemanticSegment[];
  obligations: CompactionSemanticObligation[];
  originalChars: number;
  complete: boolean;
};

export type CompactionShadowCurationResult =
  | {
      status: "ok";
      sourceFingerprint: string;
      selectedSegmentIds: string[];
      excludedSegmentIds: string[];
      uncertainSegmentIds: string[];
      evaluatedSegmentIds: string[];
      originalChars: number;
      selectedChars: number;
      reductionRatio: number;
      complete: boolean;
      provenance: {
        providerId: string;
        rubricVersion: string;
        runtimeGeneration: string;
      };
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
      };
    }
  | {
      status: "unavailable" | "skipped";
      sourceFingerprint: string;
      reason: string;
      selectedSegmentIds: string[];
      excludedSegmentIds: string[];
      uncertainSegmentIds: string[];
      evaluatedSegmentIds: string[];
      originalChars: number;
      selectedChars: number;
      reductionRatio: number;
      complete: false;
    };

export type CompactionFidelityResult =
  | {
      status: "ok";
      sourceFingerprint: string;
      candidateFingerprint: string;
      assessments: Array<{
        obligationId: string;
        classification: "preserved" | "missing" | "contradicted" | "uncertain";
        probabilities: Readonly<Record<string, number>>;
      }>;
      provenance: {
        providerId: string;
        rubricVersion: string;
        runtimeGeneration: string;
      };
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
      };
    }
  | {
      status: "unavailable" | "skipped";
      sourceFingerprint: string;
      candidateFingerprint: string;
      reason: string;
    };

function stringifyForFingerprint(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(stringifyForFingerprint(value)).digest("hex");
}

function hasUnsupportedContent(content: unknown): boolean {
  if (content == null || typeof content === "string") {
    return false;
  }
  if (!Array.isArray(content)) {
    return true;
  }
  return content.some((block) => {
    if (!block || typeof block !== "object") {
      return true;
    }
    // SAFETY: The object check above permits reading optional fields as unknown.
    const type = (block as { type?: unknown }).type;
    return type !== "text" && type !== "toolCall" && type !== "toolUse" && type !== "functionCall";
  });
}

function renderContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return content == null ? "" : stringifyForFingerprint(content);
  }
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") {
        return [];
      }
      // SAFETY: The object check above permits reading optional fields as unknown.
      const record = block as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") {
        return [record.text];
      }
      if (
        record.type === "toolCall" ||
        record.type === "toolUse" ||
        record.type === "functionCall"
      ) {
        const compact = {
          type: record.type,
          id: record.id,
          name: record.name,
          input: record.input ?? record.arguments ?? record.args,
        };
        return [stringifyForFingerprint(compact)];
      }
      return [];
    })
    .join("\n");
}

function renderMessage(message: AgentMessage): {
  text: string;
  originalChars: number;
  truncated: boolean;
  unsupported: boolean;
} {
  const role = typeof message.role === "string" ? message.role : "unknown";
  const toolName =
    message.role === "toolResult" && typeof message.toolName === "string" ? message.toolName : "";
  // SAFETY: Read only an optional unknown field across built-in and custom message roles.
  const rawContent = (message as { content?: unknown }).content;
  const unsupported = hasUnsupportedContent(rawContent);
  const content = renderContent(rawContent).trim();
  const rendered = [toolName ? `${role}(${toolName})` : role, content].filter(Boolean).join(": ");
  if (rendered.length <= MAX_SEGMENT_TEXT_CHARS) {
    return { text: rendered, originalChars: rendered.length, truncated: false, unsupported };
  }
  return {
    text: rendered.slice(0, MAX_SEGMENT_TEXT_CHARS),
    originalChars: rendered.length,
    truncated: true,
    unsupported,
  };
}

function buildSegments(params: {
  messages: AgentMessage[];
  protectedMessages: ReadonlySet<AgentMessage>;
  turnPrefixMessages: ReadonlySet<AgentMessage>;
  identifiers: readonly string[];
}): CompactionSemanticSegment[] {
  const pairing = classifyToolUseResultPairing(params.messages, {
    preserveUnframedToolResults: true,
  });
  const frameByStart = new Map(pairing.frames.map((frame) => [frame.startIndex, frame]));
  const claimedResultIndexes = new Set(
    pairing.frames.flatMap((frame) =>
      frame.occurrences.flatMap((occurrence) =>
        occurrence.sourceResultIndex === undefined ? [] : [occurrence.sourceResultIndex],
      ),
    ),
  );
  const segments: CompactionSemanticSegment[] = [];

  for (let index = 0; index < params.messages.length; index += 1) {
    if (claimedResultIndexes.has(index)) {
      continue;
    }
    const frame = frameByStart.get(index);
    const memberIndexes = frame
      ? [
          frame.startIndex,
          ...frame.occurrences.flatMap((occurrence) =>
            occurrence.sourceResultIndex === undefined ? [] : [occurrence.sourceResultIndex],
          ),
        ].toSorted((a, b) => a - b)
      : [index];
    const members = memberIndexes.flatMap((memberIndex) => {
      const message = params.messages[memberIndex];
      return message ? [message] : [];
    });
    if (members.length === 0) {
      continue;
    }

    const rendered = members.map(renderMessage);
    const combinedText = rendered
      .map((item) => item.text)
      .filter(Boolean)
      .join("\n");
    const text = combinedText.slice(0, MAX_SEGMENT_TEXT_CHARS);
    const protectionReasons = new Set<CompactionSemanticProtectionReason>();
    if (members.some((message) => message.role === "user")) {
      protectionReasons.add("user-authored");
    }
    if (members.some((message) => params.protectedMessages.has(message))) {
      protectionReasons.add("recent-turn");
    }
    if (members.some((message) => params.turnPrefixMessages.has(message))) {
      protectionReasons.add("turn-prefix");
    }
    if (members.some((message) => message.role === "toolResult") && !frame) {
      protectionReasons.add("unpaired-tool-result");
    }
    if (rendered.some((item) => item.unsupported)) {
      protectionReasons.add("unsupported-content");
    }
    if (combinedText.length > MAX_SEGMENT_TEXT_CHARS || rendered.some((item) => item.truncated)) {
      protectionReasons.add("oversized-segment");
    }
    if (params.identifiers.some((identifier) => identifier && text.includes(identifier))) {
      protectionReasons.add("exact-identifier");
    }

    segments.push({
      id: `segment-${memberIndexes[0] ?? index}`,
      sourceIndexes: memberIndexes,
      roles: members.map((message) => message.role),
      text,
      originalChars: rendered.reduce((total, item) => total + item.originalChars, 0),
      protected: protectionReasons.size > 0,
      protectionReasons: [...protectionReasons],
    });
  }

  return segments;
}

function findSourceSegmentId(
  segments: CompactionSemanticSegment[],
  sourceText: string,
): string | undefined {
  const needle = sourceText.trim();
  if (!needle) {
    return undefined;
  }
  return segments.toReversed().find((segment) => segment.text.includes(needle))?.id;
}

function buildObligations(params: {
  segments: CompactionSemanticSegment[];
  latestUnresolvedUserRequest?: string | null;
  latestUserAsk?: string | null;
}): CompactionSemanticObligation[] {
  const obligations: CompactionSemanticObligation[] = [];
  const seen = new Set<string>();
  const add = (kind: CompactionSemanticObligation["kind"], value: string | null | undefined) => {
    const raw = value?.trim();
    if (!raw || seen.has(raw)) {
      return;
    }
    seen.add(raw);
    obligations.push({
      id: `obligation-${obligations.length + 1}`,
      kind,
      text: raw.slice(0, MAX_OBLIGATION_TEXT_CHARS),
      sourceSegmentId: findSourceSegmentId(params.segments, raw),
      complete: raw.length <= MAX_OBLIGATION_TEXT_CHARS,
    });
  };
  add("unresolved-request", params.latestUnresolvedUserRequest);
  add("latest-user-ask", params.latestUserAsk);
  return obligations;
}

export function fingerprintCompactionMessages(messages: readonly AgentMessage[]): string {
  return fingerprint(
    messages.map((message) => ({
      role: message.role,
      // SAFETY: Read only an optional unknown field across built-in and custom message roles.
      timestamp: (message as { timestamp?: unknown }).timestamp,
      // SAFETY: Read only an optional unknown field across built-in and custom message roles.
      content: (message as { content?: unknown }).content,
      // SAFETY: Read only an optional unknown field across built-in and custom message roles.
      toolCallId: (message as { toolCallId?: unknown }).toolCallId,
      // SAFETY: Read only an optional unknown field across built-in and custom message roles.
      toolUseId: (message as { toolUseId?: unknown }).toolUseId,
      // SAFETY: Read only an optional unknown field across built-in and custom message roles.
      toolName: (message as { toolName?: unknown }).toolName,
      // SAFETY: Read only an optional unknown field across built-in and custom message roles.
      isError: (message as { isError?: unknown }).isError,
      // SAFETY: Read only an optional unknown field across built-in and custom message roles.
      details: (message as { details?: unknown }).details,
    })),
  );
}

export function buildCompactionSemanticSnapshot(params: {
  messages: AgentMessage[];
  protectedMessages?: ReadonlySet<AgentMessage>;
  turnPrefixMessages?: ReadonlySet<AgentMessage>;
  identifiers?: readonly string[];
  latestUnresolvedUserRequest?: string | null;
  latestUserAsk?: string | null;
}): CompactionSemanticSnapshot {
  const protectedMessages = params.protectedMessages ?? new Set<AgentMessage>();
  const turnPrefixMessages = params.turnPrefixMessages ?? new Set<AgentMessage>();
  const segments = buildSegments({
    messages: params.messages,
    protectedMessages,
    turnPrefixMessages,
    identifiers: params.identifiers ?? [],
  });
  const obligations = buildObligations({
    segments,
    latestUnresolvedUserRequest: params.latestUnresolvedUserRequest,
    latestUserAsk: params.latestUserAsk,
  });
  const obligationSources = new Set(
    obligations.flatMap((obligation) =>
      obligation.sourceSegmentId ? [obligation.sourceSegmentId] : [],
    ),
  );
  for (const segment of segments) {
    if (!obligationSources.has(segment.id)) {
      continue;
    }
    segment.protected = true;
    if (!segment.protectionReasons.includes("obligation-source")) {
      segment.protectionReasons.push("obligation-source");
    }
  }

  const complete =
    obligations.every((obligation) => obligation.complete && Boolean(obligation.sourceSegmentId)) &&
    segments.every(
      (segment) =>
        !segment.protectionReasons.includes("unsupported-content") &&
        !segment.protectionReasons.includes("oversized-segment"),
    );

  return {
    sourceFingerprint: fingerprintCompactionMessages(params.messages),
    segments,
    obligations,
    originalChars: segments.reduce((total, segment) => total + segment.originalChars, 0),
    complete,
  };
}
