import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { AgentMessage } from "../agent-core-contract.js";
import type { BlockReplyPayload } from "../pi-embedded-payloads.js";
import type { AgentRunEvent } from "../runtime-backend.js";

export const AGENT_RUN_PARENT_CALLBACK_FIELDS = [
  "onExecutionStarted",
  "onPartialReply",
  "onAssistantMessageStart",
  "onBlockReply",
  "onBlockReplyFlush",
  "onReasoningStream",
  "onReasoningEnd",
  "onToolResult",
  "onAgentEvent",
  "onUserMessagePersisted",
] as const;

export const AGENT_RUN_PARENT_POLICY_CALLBACK_FIELDS = [
  "shouldEmitToolResult",
  "shouldEmitToolOutput",
] as const;

export const AGENT_RUN_PARENT_MUTABLE_REF_FIELDS = ["abortSignal", "hasRepliedRef"] as const;

export type AgentRunParentCallbackField = (typeof AGENT_RUN_PARENT_CALLBACK_FIELDS)[number];
export type AgentRunParentPolicyCallbackField =
  (typeof AGENT_RUN_PARENT_POLICY_CALLBACK_FIELDS)[number];
export type AgentRunParentMutableRefField = (typeof AGENT_RUN_PARENT_MUTABLE_REF_FIELDS)[number];

export type AgentRunParentEventCallback =
  | "agent_event"
  | "assistant_message_start"
  | "block_reply"
  | "block_reply_flush"
  | "execution_started"
  | "has_replied"
  | "partial_reply"
  | "reasoning_end"
  | "reasoning_stream"
  | "tool_result"
  | "user_message_persisted";

export type AgentRunParentCallbackSink = {
  sessionKey?: string;
  hasRepliedRef?: { value: boolean };
  onExecutionStarted?: () => void;
  onPartialReply?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onAssistantMessageStart?: () => void | Promise<void>;
  onBlockReply?: (payload: BlockReplyPayload) => void | Promise<void>;
  onBlockReplyFlush?: () => void | Promise<void>;
  onReasoningStream?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onReasoningEnd?: () => void | Promise<void>;
  onToolResult?: (payload: ReplyPayload) => void | Promise<void>;
  onAgentEvent?: (evt: {
    stream: string;
    data: Record<string, unknown>;
    sessionKey?: string;
  }) => void | Promise<void>;
  onUserMessagePersisted?: (message: Extract<AgentMessage, { role: "user" }>) => void;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function callbackName(event: AgentRunEvent): AgentRunParentEventCallback | undefined {
  const callback = event.data.callback;
  return typeof callback === "string" ? (callback as AgentRunParentEventCallback) : undefined;
}

function eventPayload(event: AgentRunEvent): Record<string, unknown> {
  return asRecord(event.data.payload);
}

export async function forwardAgentRunEventToAttemptCallbacks(
  params: AgentRunParentCallbackSink,
  event: AgentRunEvent,
): Promise<void> {
  switch (callbackName(event)) {
    case "agent_event": {
      const stream = typeof event.data.stream === "string" ? event.data.stream : event.stream;
      await params.onAgentEvent?.({
        stream,
        data: asRecord(event.data.data),
        sessionKey: event.sessionKey ?? params.sessionKey,
      });
      return;
    }
    case "assistant_message_start":
      await params.onAssistantMessageStart?.();
      return;
    case "block_reply":
      await params.onBlockReply?.(eventPayload(event) as BlockReplyPayload);
      return;
    case "block_reply_flush":
      await params.onBlockReplyFlush?.();
      return;
    case "execution_started":
      params.onExecutionStarted?.();
      return;
    case "has_replied":
      if (params.hasRepliedRef) {
        params.hasRepliedRef.value = Boolean(event.data.value);
      }
      return;
    case "partial_reply":
      await params.onPartialReply?.(eventPayload(event) as { text?: string; mediaUrls?: string[] });
      return;
    case "reasoning_end":
      await params.onReasoningEnd?.();
      return;
    case "reasoning_stream":
      await params.onReasoningStream?.(
        eventPayload(event) as { text?: string; mediaUrls?: string[] },
      );
      return;
    case "tool_result":
      await params.onToolResult?.(eventPayload(event) as ReplyPayload);
      return;
    case "user_message_persisted":
      params.onUserMessagePersisted?.(
        eventPayload(event) as unknown as Extract<AgentMessage, { role: "user" }>,
      );
      return;
    default:
      await params.onAgentEvent?.({
        stream: event.stream,
        data: event.data,
        sessionKey: event.sessionKey ?? params.sessionKey,
      });
  }
}
