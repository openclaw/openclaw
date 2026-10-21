import type { PrepareAssistantTranscriptMessage } from "../../config/sessions/transcript-assistant-delivery.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { cloneHookIsolationValue, HookIsolationError } from "../../plugins/hook-isolation.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { applyTranscriptSenderIdentityToWrite } from "../../sessions/user-turn-transcript.metadata.js";
import { extractAssistantTranscriptSourceText } from "../../shared/chat-message-content.js";
import { consumeAdjustedParamsForToolCall } from "../agent-tools.before-tool-call.js";
import type { AgentMessage } from "../runtime/index.js";

const log = createSubsystemLogger("agents/harness");

/**
 * Isolates a tool result for after_tool_call observers.
 *
 * Plugin tools that return class instances anywhere in their result (for example
 * Firestore Timestamps nested in a document) come back as plugin-owned value
 * views, which are Proxies and rejected by structuredClone. after_tool_call is a
 * best-effort observation, so such results are handed to hooks as an isolated
 * JSON data projection instead of dropping the whole event. When even that is
 * impossible the event is still delivered, just without `result`.
 */
function isolateAfterToolCallResult(toolName: string, result: unknown): unknown {
  try {
    return cloneHookIsolationValue("after_tool_call", result);
  } catch (error) {
    if (!(error instanceof HookIsolationError)) {
      throw error;
    }
    try {
      const json = JSON.stringify(result);
      return json === undefined
        ? undefined
        : cloneHookIsolationValue("after_tool_call", JSON.parse(json) as unknown);
    } catch (projectionError) {
      log.debug(
        `after_tool_call result omitted: tool=${toolName} cause=${String(error.cause ?? error)} projection=${String(projectionError)}`,
      );
      return undefined;
    }
  }
}

/** Runs best-effort after-tool-call hooks for a completed tool invocation. */
export async function runAgentHarnessAfterToolCallHook(params: {
  toolName: string;
  toolCallId: string;
  runId?: string;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  channelId?: string;
  startArgs: Record<string, unknown>;
  result?: unknown;
  error?: string;
  startedAt?: number;
}): Promise<void> {
  const adjustedArgs = consumeAdjustedParamsForToolCall(params.toolCallId, params.runId);
  // Hooks should see adjusted tool params when before_tool_call rewrote them.
  const resolvedArgs =
    adjustedArgs && typeof adjustedArgs === "object"
      ? (adjustedArgs as Record<string, unknown>)
      : params.startArgs;
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("after_tool_call")) {
    return;
  }
  try {
    const eventArgs = structuredClone(resolvedArgs);
    const eventResult = isolateAfterToolCallResult(params.toolName, params.result);
    await hookRunner.runAfterToolCall(
      {
        toolName: params.toolName,
        params: eventArgs,
        ...(params.runId ? { runId: params.runId } : {}),
        toolCallId: params.toolCallId,
        ...(eventResult ? { result: eventResult } : {}),
        ...(params.error ? { error: params.error } : {}),
        ...(params.startedAt != null ? { durationMs: Date.now() - params.startedAt } : {}),
      },
      {
        toolName: params.toolName,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        ...(params.runId ? { runId: params.runId } : {}),
        ...(params.channelId ? { channelId: params.channelId } : {}),
        toolCallId: params.toolCallId,
      },
    );
  } catch (error) {
    log.warn(`after_tool_call hook failed: tool=${params.toolName} error=${String(error)}`);
  }
}

/** Runs before-message-write hooks and returns the possibly rewritten message. */
export function runAgentHarnessBeforeMessageWriteHook(params: {
  message: AgentMessage;
  agentId?: string;
  sessionKey?: string;
  prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
  skipBeforeMessageWriteHooks?: boolean;
}): AgentMessage | null {
  // A hook can mutate the original object or replace it. Only the runtime's
  // original reply belongs to delivery; newly inserted references remain prose.
  const sourceText =
    params.prepareAssistantTranscriptMessage &&
    params.message.role === "assistant" &&
    Reflect.get(params.message, "display") !== false
      ? extractAssistantTranscriptSourceText(params.message)
      : undefined;
  const hookRunner = getGlobalHookRunner();
  const message =
    !params.skipBeforeMessageWriteHooks && hookRunner?.hasHooks("before_message_write")
      ? (applyTranscriptSenderIdentityToWrite(params.message, () => {
          const result = hookRunner.runBeforeMessageWrite(
            { message: params.message },
            { agentId: params.agentId, sessionKey: params.sessionKey },
          );
          return result?.block ? null : (result?.message ?? params.message);
        }) ?? null)
      : params.message;
  return message?.role === "assistant" &&
    Reflect.get(message, "display") !== false &&
    sourceText !== undefined &&
    params.prepareAssistantTranscriptMessage
    ? params.prepareAssistantTranscriptMessage(message, sourceText)
    : message;
}
