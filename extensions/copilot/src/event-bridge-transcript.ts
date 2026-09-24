import type { Attachment, SessionEvent } from "@github/copilot-sdk";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { sanitizeToolResult } from "openclaw/plugin-sdk/agent-harness-runtime";
import { parseDateStringTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import {
  asNonArrayRecord,
  readNonEmptyStringPreservingWhitespace as readNonEmptyString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { buildCopilotAssistantUsage, type CopilotUsageSnapshot } from "./usage-bridge.js";

export type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
export type AssistantUsageSnapshot = CopilotUsageSnapshot;

export type AssistantProjectionChunk = {
  assistantTexts: string[];
  event: Extract<SessionEvent, { type: "assistant.message" }>;
  reasoningText?: string;
  transcriptAssistantTexts: string[];
  transcriptReasoningText?: string;
};
export type AssistantProjectionGroup = {
  apiCallId?: string;
  chunks: AssistantProjectionChunk[];
};

export interface AttemptTranscriptJournalProjection {
  markReplayIncomplete(): void;
  recordAssistantProjectionGap(): void;
  recordAssistant(input: {
    eventId: string;
    message: AssistantMessage;
    replayIncomplete?: boolean;
    toolCallIds: string[];
  }): void;
  recordSdkUser(input: {
    autopilotContinuation: boolean;
    eventId: string;
    message: Extract<AgentMessage, { role: "user" }>;
    replayIncomplete?: boolean;
  }): void;
  recordToolResult(input: {
    eventId: string;
    message: Extract<AgentMessage, { role: "toolResult" }>;
    replayIncomplete?: boolean;
  }): void;
}

export function buildAssistantMessage(params: {
  assistantTexts: string[];
  event?: Extract<SessionEvent, { type: "assistant.message" }>;
  modelRef: { api?: string; id: string; provider: string };
  now: () => number;
  reasoningText?: string;
  usage?: AssistantUsageSnapshot;
}): AssistantMessage | undefined {
  const event = params.event;
  const text = event ? event.data.content || params.assistantTexts.at(-1) || "" : "";
  const reasoningText = event?.data.reasoningText ?? params.reasoningText;
  const toolRequests = event?.data.toolRequests ?? [];
  if (!text && !reasoningText && toolRequests.length === 0) {
    return undefined;
  }
  const content: AssistantMessage["content"] = [];
  if (reasoningText) {
    content.push({ thinking: reasoningText, type: "thinking" });
  }
  if (text) {
    content.push({ text, type: "text" });
  }
  for (const request of toolRequests) {
    content.push({
      arguments: asNonArrayRecord(request.arguments),
      id: request.toolCallId,
      name: request.name,
      type: "toolCall",
    });
  }
  return {
    api: params.modelRef.api ?? "openai-responses",
    content,
    model: event?.data.model ?? params.modelRef.id,
    provider: params.modelRef.provider,
    role: "assistant",
    stopReason: toolRequests.length > 0 ? "toolUse" : "stop",
    timestamp: params.now(),
    usage: buildCopilotAssistantUsage({
      fallbackOutputTokens: event?.data.outputTokens,
      usage: params.usage,
    }),
  };
}

export function buildAssistantProjectionGroup(
  group: AssistantProjectionGroup,
  modelRef: { api?: string; id: string; provider: string },
  resolveTimestamp: (event: Extract<SessionEvent, { type: "assistant.message" }>) => number,
  usageByApiCallId: Map<string, AssistantUsageSnapshot>,
  latestUsage: AssistantUsageSnapshot | undefined,
  forTranscript: boolean,
): {
  message: AssistantMessage | undefined;
  replayIncomplete: boolean;
  toolCallIds: string[];
} {
  const messages = group.chunks.flatMap((chunk) => {
    const message = buildAssistantMessage({
      event: chunk.event,
      modelRef,
      now: () => resolveTimestamp(chunk.event),
      reasoningText: forTranscript ? chunk.transcriptReasoningText : chunk.reasoningText,
      // Usage is keyed to the complete API call, so every chunk resolves to the
      // same snapshot and the merged message keeps the terminal copy.
      usage: resolveAssistantUsage(chunk.event, latestUsage, usageByApiCallId),
      assistantTexts: forTranscript ? chunk.transcriptAssistantTexts : chunk.assistantTexts,
    });
    return message ? [message] : [];
  });
  const replayIncomplete = group.chunks.some(({ event }) =>
    hasUnprojectedAssistantReplayState(event),
  );
  const last = messages.at(-1);
  if (!last) {
    return { message: undefined, replayIncomplete, toolCallIds: [] };
  }
  const narrative: AssistantMessage["content"] = [];
  let terminalThinking:
    | Extract<AssistantMessage["content"][number], { type: "thinking" }>
    | undefined;
  const toolCallOrder: string[] = [];
  const toolCallsById = new Map<
    string,
    Extract<AssistantMessage["content"][number], { type: "toolCall" }>
  >();
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "toolCall") {
        if (!toolCallsById.has(part.id)) {
          toolCallOrder.push(part.id);
        }
        toolCallsById.set(part.id, part);
        continue;
      }
      if (part.type === "thinking") {
        // Reasoning is an accumulated snapshot, not a per-message delta. Keep
        // only the terminal snapshot when one API call emits phased chunks.
        terminalThinking = part;
        continue;
      }
      const previous = narrative.at(-1);
      if (part.type === "text" && previous?.type === "text") {
        narrative[narrative.length - 1] = { ...previous, text: previous.text + part.text };
      } else {
        narrative.push(part);
      }
    }
  }
  const toolCalls = toolCallOrder.flatMap((id) => {
    const toolCall = toolCallsById.get(id);
    return toolCall ? [toolCall] : [];
  });
  const content = [...(terminalThinking ? [terminalThinking] : []), ...narrative, ...toolCalls];
  const toolCallIds = [...toolCallOrder];
  return {
    message: {
      ...last,
      content,
      stopReason: toolCallIds.length > 0 ? "toolUse" : "stop",
    },
    replayIncomplete,
    toolCallIds,
  };
}

function hasUnprojectedAssistantReplayState(
  event: Extract<SessionEvent, { type: "assistant.message" }>,
): boolean {
  // The SDK contract marks these as provider/session-bound state or custom
  // call shape. AgentMessage cannot represent them, so native replay must stay.
  return (
    event.data.citations !== undefined ||
    event.data.serverTools !== undefined ||
    event.data.reasoningWireField !== undefined ||
    event.data.reasoningOpaque !== undefined ||
    event.data.encryptedContent !== undefined ||
    event.data.toolRequests?.some((request) => request.type === "custom") === true
  );
}

export function resolveAssistantUsage(
  event: Extract<SessionEvent, { type: "assistant.message" }> | undefined,
  latest: AssistantUsageSnapshot | undefined,
  byApiCallId: Map<string, AssistantUsageSnapshot>,
): AssistantUsageSnapshot | undefined {
  const apiCallId = readNonEmptyString(event?.data.apiCallId);
  return apiCallId ? (byApiCallId.get(apiCallId) ?? latest) : latest;
}

export function resolveEventTimestamp(timestamp: string, now: () => number): number {
  return parseDateStringTimestampMs(timestamp) ?? now();
}

export function hasOwnKeys(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && Object.keys(value).length > 0);
}

export function projectSdkUserMetadata(
  attachments: Attachment[] | undefined,
  source: string | undefined,
): Record<string, unknown> | undefined {
  const summaries = (attachments ?? []).map((attachment) => {
    const {
      data: _data,
      payload: _payload,
      text: _text,
      ...summary
    } = attachment as Attachment & {
      data?: unknown;
      payload?: unknown;
      text?: unknown;
    };
    return summary;
  });
  const media = (attachments ?? []).flatMap<{
    contentType?: string;
    kind?: string;
    path: string;
  }>((attachment) => {
    if (attachment.type === "file") {
      return [{ path: attachment.path, contentType: attachment.mimeType }];
    }
    return attachment.type === "selection" ? [{ path: attachment.filePath, kind: "document" }] : [];
  });
  if (!source && summaries.length === 0) {
    return undefined;
  }
  return {
    ...(source ? { copilotSource: source } : {}),
    ...(summaries.length > 0 ? { copilotAttachments: summaries } : {}),
    ...(media.length > 0 ? { media } : {}),
  };
}

export function projectToolResultDetails(
  data: Extract<SessionEvent, { type: "tool.execution_complete" }>["data"],
): unknown {
  const result = data.result;
  const sanitizedContents = result?.contents
    ? (sanitizeToolResult({ content: result.contents }) as { content?: unknown }).content
    : undefined;
  const binaryResultsForLlm = result?.binaryResultsForLlm?.map((entry) => {
    const { data: _data, ...descriptor } = entry as typeof entry & { data?: unknown };
    return descriptor;
  });
  const citableSources = result?.citableSources?.map((source) =>
    Object.assign({}, source, { content: sanitizeToolDetailText(source.content) }),
  );
  return sanitizeToolResult({
    ...(result?.detailedContent
      ? { content: [{ type: "text", text: result.detailedContent }] }
      : {}),
    ...(result?.structuredContent ? { structuredContent: result.structuredContent } : {}),
    ...(sanitizedContents ? { contents: sanitizedContents } : {}),
    ...(binaryResultsForLlm?.length ? { binaryResultsForLlm } : {}),
    ...(citableSources?.length ? { citableSources } : {}),
    ...(data.mcpMeta || result?.mcpMeta ? { mcpMeta: data.mcpMeta ?? result?.mcpMeta } : {}),
  });
}

export function sanitizeToolDetailText(text: string): string {
  const sanitized = sanitizeToolResult({ content: [{ type: "text", text }] }) as {
    content?: Array<{ text?: unknown }>;
  };
  const value = sanitized.content?.[0]?.text;
  return typeof value === "string" ? value : "";
}
