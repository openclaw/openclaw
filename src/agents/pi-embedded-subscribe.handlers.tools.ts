import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { PluginHookAfterToolCallEvent } from "../plugins/types.js";
import type {
  EmbeddedPiSubscribeContext,
  ToolCallSummary,
} from "./pi-embedded-subscribe.handlers.types.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { normalizeTextForComparison } from "./pi-embedded-helpers.js";
import { isMessagingTool, isMessagingToolSendAction } from "./pi-embedded-messaging.js";
import {
  extractToolErrorMessage,
  extractToolResultMediaPaths,
  extractToolResultText,
  extractMessagingToolSend,
  isToolResultError,
  sanitizeToolResult,
} from "./pi-embedded-subscribe.tools.js";
import { inferToolMetaFromArgs } from "./pi-embedded-utils.js";
import { buildToolMutationState, isSameToolMutationAction } from "./tool-mutation.js";
import { normalizeToolName } from "./tool-policy.js";

function buildToolCallSummary(toolName: string, args: unknown, meta?: string): ToolCallSummary {
  const mutation = buildToolMutationState(toolName, args, meta);
  return {
    meta,
    mutatingAction: mutation.mutatingAction,
    actionFingerprint: mutation.actionFingerprint,
  };
}

function extendExecMeta(toolName: string, args: unknown, meta?: string): string | undefined {
  const normalized = toolName.trim().toLowerCase();
  if (normalized !== "exec" && normalized !== "bash") {
    return meta;
  }
  if (!args || typeof args !== "object") {
    return meta;
  }
  const record = args as Record<string, unknown>;
  const flags: string[] = [];
  if (record.pty === true) {
    flags.push("pty");
  }
  if (record.elevated === true) {
    flags.push("elevated");
  }
  if (flags.length === 0) {
    return meta;
  }
  const suffix = flags.join(" · ");
  return meta ? `${meta} · ${suffix}` : suffix;
}

export async function handleToolExecutionStart(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & { toolName: string; toolCallId: string; args: unknown },
) {
  // Early return FIRST if run was already unsubscribed (aborted), before touching any state.
  // This prevents race where timeout/unsubscribe happens after event fires but before
  // we set state, which would leave dirty state that never gets cleaned up.
  if (ctx.state.unsubscribed) {
    ctx.log.debug(`tool_execution_start skipped (unsubscribed): tool=${String(evt.toolName)}`);
    return;
  }

  // Flush pending block replies to preserve message boundaries before tool execution.
  ctx.flushBlockReplyBuffer();
  if (ctx.params.onBlockReplyFlush) {
    void ctx.params.onBlockReplyFlush();
  }

  const rawToolName = String(evt.toolName);
  const toolName = normalizeToolName(rawToolName);
  const toolCallId = String(evt.toolCallId);
  const args = evt.args;

  // Check unsubscribed again after async operations (flushBlockReplyBuffer) to prevent
  // race where timeout/unsubscribe happens during those operations, which would leave state dirty.
  if (ctx.state.unsubscribed) {
    ctx.log.debug(`tool_execution_start skipped (unsubscribed after flush): tool=${toolName}`);
    return;
  }

  // Capture start time once for consistent timestamps across state and hook tracking.
  const startTime = Date.now();

  // Track tool execution with reference counting to properly handle concurrent tools.
  // toolExecutionCount tracks all active tools, while activeToolName/CallId/StartTime
  // track only the most recent (used for timeout snapshots).
  ctx.state.toolExecutionCount++;
  ctx.state.toolExecutionInFlight = ctx.state.toolExecutionCount > 0;
  ctx.state.activeToolName = toolName;
  ctx.state.activeToolCallId = toolCallId;
  ctx.state.activeToolStartTime = startTime;

  // Track start time and args for after_tool_call hook.
  ctx.state.toolStartData.set(toolCallId, { startTime, args });

  // Call before_tool_call hook.
  const hookRunner = ctx.hookRunner ?? getGlobalHookRunner();
  if (hookRunner?.hasHooks?.("before_tool_call")) {
    try {
      const hookEvent: PluginHookBeforeToolCallEvent = {
        toolName,
        params: args && typeof args === "object" ? (args as Record<string, unknown>) : {},
      };
      await hookRunner.runBeforeToolCall(hookEvent, { toolName });
    } catch (err) {
      ctx.log.debug(`before_tool_call hook failed: tool=${toolName} error=${String(err)}`);
    }
  }

  // Check unsubscribed again after hook (another async point) to prevent
  // state corruption if timeout/unsubscribe happened during hook execution.
  if (ctx.state.unsubscribed) {
    ctx.log.debug(`tool_execution_start skipped (unsubscribed after hook): tool=${toolName}`);
    // Clean up state we just set
    ctx.state.toolExecutionCount = Math.max(0, ctx.state.toolExecutionCount - 1);
    ctx.state.toolExecutionInFlight = ctx.state.toolExecutionCount > 0;
    if (ctx.state.activeToolCallId === toolCallId) {
      ctx.state.activeToolName = undefined;
      ctx.state.activeToolCallId = undefined;
      ctx.state.activeToolStartTime = undefined;
    }
    ctx.state.toolStartData.delete(toolCallId);
    return;
  }


  if (toolName === "read") {
    const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const filePathValue =
      typeof record.path === "string"
        ? record.path
        : typeof record.file_path === "string"
          ? record.file_path
          : "";
    const filePath = filePathValue.trim();
    if (!filePath) {
      const argsPreview = typeof args === "string" ? args.slice(0, 200) : undefined;
      ctx.log.warn(
        `read tool called without path: toolCallId=${toolCallId} argsType=${typeof args}${argsPreview ? ` argsPreview=${argsPreview}` : ""}`,
      );
    }
  }

  const meta = extendExecMeta(toolName, args, inferToolMetaFromArgs(toolName, args));
  ctx.state.toolMetaById.set(toolCallId, buildToolCallSummary(toolName, args, meta));
  ctx.log.debug(
    `embedded run tool start: runId=${ctx.params.runId} tool=${toolName} toolCallId=${toolCallId}`,
  );

  const shouldEmitToolEvents = ctx.shouldEmitToolResult();
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "tool",
    data: {
      phase: "start",
      name: toolName,
      toolCallId,
      args: args as Record<string, unknown>,
    },
  });
  // Best-effort typing signal; do not block tool summaries on slow emitters.
  void ctx.params.onAgentEvent?.({
    stream: "tool",
    data: { phase: "start", name: toolName, toolCallId },
  });

  if (
    ctx.params.onToolResult &&
    shouldEmitToolEvents &&
    !ctx.state.toolSummaryById.has(toolCallId)
  ) {
    ctx.state.toolSummaryById.add(toolCallId);
    ctx.emitToolSummary(toolName, meta);
  }

  // Track messaging tool sends (pending until confirmed in tool_execution_end).
  if (isMessagingTool(toolName)) {
    const argsRecord = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const isMessagingSend = isMessagingToolSendAction(toolName, argsRecord);
    if (isMessagingSend) {
      const sendTarget = extractMessagingToolSend(toolName, argsRecord);
      if (sendTarget) {
        ctx.state.pendingMessagingTargets.set(toolCallId, sendTarget);
      }
      // Field names vary by tool: Discord/Slack use "content", sessions_send uses "message"
      const text = (argsRecord.content as string) ?? (argsRecord.message as string);
      if (text && typeof text === "string") {
        ctx.state.pendingMessagingTexts.set(toolCallId, text);
        ctx.log.debug(`Tracking pending messaging text: tool=${toolName} len=${text.length}`);
      }
    }
  }
}

export function handleToolExecutionUpdate(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & {
    toolName: string;
    toolCallId: string;
    partialResult?: unknown;
  },
) {
  const toolName = normalizeToolName(String(evt.toolName));
  const toolCallId = String(evt.toolCallId);
  const partial = evt.partialResult;
  const sanitized = sanitizeToolResult(partial);
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "tool",
    data: {
      phase: "update",
      name: toolName,
      toolCallId,
      partialResult: sanitized,
    },
  });
  void ctx.params.onAgentEvent?.({
    stream: "tool",
    data: {
      phase: "update",
      name: toolName,
      toolCallId,
    },
  });
}

export async function handleToolExecutionEnd(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & {
    toolName: string;
    toolCallId: string;
    isError: boolean;
    result?: unknown;
  },
) {
  const toolName = normalizeToolName(String(evt.toolName));
  const toolCallId = String(evt.toolCallId);
  const isError = Boolean(evt.isError);
  const result = evt.result;

  try {
    // Early return if run was already unsubscribed (aborted).
    // This is a race condition where the tool event fired after unsubscribe was called
    // (e.g., timeout during tool execution). We skip the normal cleanup logic which may
    // access already-cleared maps or attempt to emit events to a closed subscription.
    // State clearing happens in finally block to ensure it runs in all cases.
    if (ctx.state.unsubscribed) {
      ctx.log.debug(`tool_execution_end skipped (unsubscribed): tool=${toolName}`);
      return;
    }

    const isToolError = isError || isToolResultError(result);
    const sanitizedResult = sanitizeToolResult(result);
    const callSummary = ctx.state.toolMetaById.get(toolCallId);
    const meta = callSummary?.meta;
    ctx.state.toolMetas.push({ toolName, meta });
    ctx.state.toolMetaById.delete(toolCallId);
    ctx.state.toolSummaryById.delete(toolCallId);
    if (isToolError) {
      const errorMessage = extractToolErrorMessage(sanitizedResult);
      ctx.state.lastToolError = {
        toolName,
        meta,
        error: errorMessage,
        mutatingAction: callSummary?.mutatingAction,
        actionFingerprint: callSummary?.actionFingerprint,
      };
    } else if (ctx.state.lastToolError) {
      // Keep unresolved mutating failures until the same action succeeds.
      if (ctx.state.lastToolError.mutatingAction) {
        if (
          isSameToolMutationAction(ctx.state.lastToolError, {
            toolName,
            meta,
            actionFingerprint: callSummary?.actionFingerprint,
          })
        ) {
          ctx.state.lastToolError = undefined;
        }
      } else {
        ctx.state.lastToolError = undefined;
      }
    }

    // Commit messaging tool text on success, discard on error.
    const pendingText = ctx.state.pendingMessagingTexts.get(toolCallId);
    const pendingTarget = ctx.state.pendingMessagingTargets.get(toolCallId);
    if (pendingText) {
      ctx.state.pendingMessagingTexts.delete(toolCallId);
      if (!isToolError) {
        ctx.state.messagingToolSentTexts.push(pendingText);
        ctx.state.messagingToolSentTextsNormalized.push(normalizeTextForComparison(pendingText));
        ctx.log.debug(`Committed messaging text: tool=${toolName} len=${pendingText.length}`);
        ctx.trimMessagingToolSent();
      }
    }
    if (pendingTarget) {
      ctx.state.pendingMessagingTargets.delete(toolCallId);
      if (!isToolError) {
        ctx.state.messagingToolSentTargets.push(pendingTarget);
        ctx.trimMessagingToolSent();
      }
    }

    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "tool",
      data: {
        phase: "result",
        name: toolName,
        toolCallId,
        meta,
        isError: isToolError,
        result: sanitizedResult,
      },
    });
    void ctx.params.onAgentEvent?.({
      stream: "tool",
      data: {
        phase: "result",
        name: toolName,
        toolCallId,
        meta,
        isError: isToolError,
      },
    });

    ctx.log.debug(
      `embedded run tool end: runId=${ctx.params.runId} tool=${toolName} toolCallId=${toolCallId}`,
    );

    if (ctx.params.onToolResult && ctx.shouldEmitToolOutput()) {
      const outputText = extractToolResultText(sanitizedResult);
      if (outputText) {
        ctx.emitToolOutput(toolName, meta, outputText);
      }
    }

    // Deliver media from tool results when the verbose emitToolOutput path is off.
    // When shouldEmitToolOutput() is true, emitToolOutput already delivers media
    // via parseReplyDirectives (MEDIA: text extraction), so skip to avoid duplicates.
    if (ctx.params.onToolResult && !isToolError && !ctx.shouldEmitToolOutput()) {
      const mediaPaths = extractToolResultMediaPaths(result);
      if (mediaPaths.length > 0) {
        try {
          void ctx.params.onToolResult({ mediaUrls: mediaPaths });
        } catch {
          // ignore delivery failures
        }
      }
    }

    // Run after_tool_call plugin hook (fire-and-forget).
    const hookRunnerAfter = ctx.hookRunner ?? getGlobalHookRunner();
    if (hookRunnerAfter?.hasHooks("after_tool_call")) {
      const startData = ctx.state.toolStartData.get(toolCallId);
      const durationMs =
        startData?.startTime != null ? Date.now() - startData.startTime : undefined;
      const toolArgs = startData?.args;
      const hookEvent: PluginHookAfterToolCallEvent = {
        toolName,
        params: (toolArgs && typeof toolArgs === "object" ? toolArgs : {}) as Record<
          string,
          unknown
        >,
        result: sanitizedResult,
        error: isToolError ? extractToolErrorMessage(sanitizedResult) : undefined,
        durationMs,
      };
      void hookRunnerAfter
        .runAfterToolCall(hookEvent, {
          toolName,
          agentId: undefined,
          sessionKey: undefined,
        })
        .catch((err) => {
          ctx.log.warn(`after_tool_call hook failed: tool=${toolName} error=${String(err)}`);
        });
    }
  } finally {
    // Skip all state updates if unsubscribed to prevent interfering with
    // concurrent tools or stale state after subscription cleanup.
    if (!ctx.state.unsubscribed) {
      // Only decrement if this tool was actually tracked (i.e., handleToolExecutionStart
      // got past unsubscribe checks and incremented the count). Check toolStartData presence
      // BEFORE deleting it.
      const wasTracked = ctx.state.toolStartData.has(toolCallId);
      if (wasTracked) {
        ctx.state.toolExecutionCount = Math.max(0, ctx.state.toolExecutionCount - 1);
        ctx.state.toolExecutionInFlight = ctx.state.toolExecutionCount > 0;
      }

      // Only clear snapshot state if it still points to THIS tool AND we tracked it.
      // For concurrent tools, activeToolName/CallId/StartTime track only the most recent.
      if (wasTracked && ctx.state.activeToolCallId === toolCallId) {
        ctx.state.activeToolName = undefined;
        ctx.state.activeToolCallId = undefined;
        ctx.state.activeToolStartTime = undefined;
      }
    }
    // Always clean up per-tool tracking map to prevent memory leaks
    ctx.state.toolStartData.delete(toolCallId);
  }
}
