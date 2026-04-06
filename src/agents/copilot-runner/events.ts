/**
 * Translate Copilot SDK SessionEvents into OpenClaw's callback/payload model.
 *
 * The SDK emits events like `assistant.message_delta`, `tool.execution_start`,
 * `assistant.turn_end`, etc. These map to OpenClaw's `onPartialReply`,
 * `onAgentEvent`, `onBlockReply`, and the final `EmbeddedPiRunResult` payloads.
 */
import type { SessionEvent } from "@github/copilot-sdk";
import type { BlockReplyPayload } from "../pi-embedded-payloads.js";
import type {
  EmbeddedPiAgentMeta,
  EmbeddedPiRunMeta,
  EmbeddedPiRunResult,
} from "../pi-embedded-runner/types.js";

// ── Accumulator ────────────────────────────────────────────────────────────

/** Collects streaming event data and produces the final EmbeddedPiRunResult. */
export type RunAccumulator = {
  /** Full assistant message text assembled from deltas. */
  text: string;
  /** Media URLs extracted from events. */
  mediaUrls: string[];
  /** Whether the assistant response contained reasoning content. */
  hasReasoning: boolean;
  /** Reasoning text assembled from deltas. */
  reasoningText: string;
  /** Usage from assistant.usage events. */
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  /** Model info from session metadata. */
  model: string;
  provider: string;
  sessionId: string;
  /** Count of tool calls executed. */
  toolCallCount: number;
  /** Track if we got any assistant content. */
  hasContent: boolean;
  /** True until the first assistant.message_delta fires (per turn). */
  awaitingFirstDelta: boolean;
  /** Whether the run was aborted by the caller. */
  aborted: boolean;
  /** Whether the run timed out. */
  timedOut: boolean;
  /** Stop reason from the last assistant turn. */
  stopReason?: string;
  /** Tool result text collected from tool.execution_complete events. */
  lastToolResultText?: string;
  /** Error, if any. */
  error?: { kind: string; message: string };
};

export function createRunAccumulator(opts: {
  sessionId: string;
  model: string;
  provider: string;
}): RunAccumulator {
  return {
    text: "",
    mediaUrls: [],
    hasReasoning: false,
    reasoningText: "",
    usage: {},
    model: opts.model,
    provider: opts.provider,
    sessionId: opts.sessionId,
    toolCallCount: 0,
    hasContent: false,
    awaitingFirstDelta: true,
    aborted: false,
    timedOut: false,
  };
}

// ── Event Handlers ─────────────────────────────────────────────────────────

export type RunCallbacks = {
  onPartialReply?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onAssistantMessageStart?: () => void | Promise<void>;
  onBlockReply?: (payload: BlockReplyPayload) => void | Promise<void>;
  onBlockReplyFlush?: () => void | Promise<void>;
  onReasoningStream?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onReasoningEnd?: () => void | Promise<void>;
  onToolResult?: (payload: { text?: string }) => void | Promise<void>;
  onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
};

/**
 * Process a single SDK SessionEvent, updating the accumulator and firing
 * the appropriate OpenClaw callbacks.
 */
export async function handleSessionEvent(
  event: SessionEvent,
  acc: RunAccumulator,
  callbacks: RunCallbacks,
): Promise<void> {
  const type = event.type;
  const data = event.data as Record<string, unknown>;

  switch (type) {
    case "assistant.message_delta": {
      const delta = (data.deltaContent as string) ?? "";
      if (acc.awaitingFirstDelta) {
        acc.awaitingFirstDelta = false;
        await callbacks.onAssistantMessageStart?.();
      }
      acc.text += delta;
      acc.hasContent = true;
      await callbacks.onPartialReply?.({ text: delta });
      await callbacks.onBlockReply?.({ text: delta });
      break;
    }

    case "assistant.message": {
      // Full message (non-streaming mode or final consolidated).
      const content = (data.content as string) ?? "";
      if (!acc.hasContent && content) {
        acc.text = content;
        acc.hasContent = true;
        await callbacks.onAssistantMessageStart?.();
        await callbacks.onPartialReply?.({ text: content });
        await callbacks.onBlockReply?.({ text: content });
      }
      break;
    }

    case "assistant.reasoning_delta": {
      const delta = (data.deltaContent as string) ?? "";
      acc.hasReasoning = true;
      acc.reasoningText += delta;
      await callbacks.onReasoningStream?.({ text: delta });
      break;
    }

    case "assistant.reasoning": {
      const content = (data.content as string) ?? "";
      if (content) {
        acc.hasReasoning = true;
        acc.reasoningText = content;
      }
      await callbacks.onReasoningEnd?.();
      break;
    }

    case "assistant.turn_start": {
      acc.awaitingFirstDelta = true;
      callbacks.onAgentEvent?.({
        stream: "lifecycle",
        data: { phase: "turn_start" },
      });
      break;
    }

    case "assistant.turn_end": {
      await callbacks.onBlockReplyFlush?.();
      callbacks.onAgentEvent?.({
        stream: "lifecycle",
        data: { phase: "turn_end" },
      });
      break;
    }

    case "assistant.usage": {
      const usage = data;
      acc.usage = {
        input: typeof usage.inputTokens === "number" ? usage.inputTokens : undefined,
        output: typeof usage.outputTokens === "number" ? usage.outputTokens : undefined,
        total: typeof usage.totalTokens === "number" ? usage.totalTokens : undefined,
      };
      break;
    }

    case "tool.execution_start": {
      const toolName = typeof data.toolName === "string" ? data.toolName : undefined;
      callbacks.onAgentEvent?.({
        stream: "tool",
        data: { phase: "start", name: toolName },
      });
      break;
    }

    case "tool.execution_complete": {
      acc.toolCallCount += 1;
      const toolName = typeof data.toolName === "string" ? data.toolName : undefined;
      const toolOutput = typeof data.result === "string" ? data.result : undefined;
      acc.lastToolResultText = toolOutput;
      callbacks.onAgentEvent?.({
        stream: "tool",
        data: { phase: "complete", name: toolName },
      });
      if (toolOutput) {
        await callbacks.onToolResult?.({ text: toolOutput });
      }
      break;
    }

    case "tool.execution_partial_result": {
      const toolName = typeof data.toolName === "string" ? data.toolName : undefined;
      callbacks.onAgentEvent?.({
        stream: "tool",
        data: { phase: "update", name: toolName },
      });
      break;
    }

    case "tool.user_requested": {
      const toolName = typeof data.toolName === "string" ? data.toolName : undefined;
      callbacks.onAgentEvent?.({
        stream: "tool",
        data: { phase: "requested", name: toolName },
      });
      break;
    }

    case "session.idle": {
      callbacks.onAgentEvent?.({
        stream: "lifecycle",
        data: { phase: "idle" },
      });
      break;
    }

    case "session.error": {
      const message = typeof data.message === "string" ? data.message : "Unknown session error";
      acc.error = { kind: "session_error", message };
      break;
    }

    default:
      // Unhandled events are silently ignored — the SDK emits many
      // informational events (session.start, capabilities.changed, etc.)
      // that don't need OpenClaw callbacks.
      break;
  }
}

// ── Result Builder ─────────────────────────────────────────────────────────

/** Build the final EmbeddedPiRunResult from the accumulated event data. */
export function buildRunResult(acc: RunAccumulator, durationMs: number): EmbeddedPiRunResult {
  const payloads: NonNullable<EmbeddedPiRunResult["payloads"]> = [];

  // Add reasoning payload if present.
  if (acc.hasReasoning && acc.reasoningText) {
    payloads.push({
      text: acc.reasoningText,
      isReasoning: true,
    });
  }

  // Add the main assistant text payload.
  if (acc.text) {
    payloads.push({
      text: acc.text,
      ...(acc.mediaUrls.length > 0 ? { mediaUrls: acc.mediaUrls } : {}),
    });
  }

  const agentMeta: EmbeddedPiAgentMeta = {
    sessionId: acc.sessionId,
    provider: acc.provider,
    model: acc.model,
    usage: acc.usage,
    lastCallUsage: acc.usage,
  };

  // Map error kind: distinguish timeout vs session error vs generic.
  const resolvedErrorKind = acc.error
    ? acc.timedOut
      ? ("retry_limit" as const)
      : ("context_overflow" as const)
    : undefined;

  const meta: EmbeddedPiRunMeta = {
    durationMs,
    agentMeta,
    aborted: acc.aborted || undefined,
    stopReason: acc.stopReason,
    ...(acc.error && resolvedErrorKind
      ? {
          error: {
            kind: resolvedErrorKind,
            message: acc.error.message,
          },
        }
      : {}),
  };

  return {
    payloads: payloads.length > 0 ? payloads : undefined,
    meta,
  };
}
