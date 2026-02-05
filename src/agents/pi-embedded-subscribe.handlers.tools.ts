import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import crypto from "node:crypto";
import { emitAgentEvent } from "../infra/agent-events.js";
import { normalizeTextForComparison } from "./pi-embedded-helpers.js";
import { isMessagingTool, isMessagingToolSendAction } from "./pi-embedded-messaging.js";
import {
  extractToolErrorMessage,
  extractToolResultText,
  extractMessagingToolSend,
  isToolResultError,
  sanitizeToolResult,
} from "./pi-embedded-subscribe.tools.js";
import { inferToolMetaFromArgs } from "./pi-embedded-utils.js";
import { normalizeToolName } from "./tool-policy.js";

// Loop detection configuration
const LOOP_DETECTION_HISTORY_SIZE = 10;
const LOOP_DETECTION_FAILURE_THRESHOLD = 2;
const LOOP_DETECTION_TIME_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function hashToolArgs(args: unknown): string {
  let normalized: string;
  try {
    if (args === null || args === undefined) {
      normalized = String(args);
    } else if (typeof args === "object" && !Array.isArray(args)) {
      // Sort object keys for consistent hashing
      const sorted = Object.keys(args).sort();
      normalized = JSON.stringify(args, sorted);
    } else {
      normalized = JSON.stringify(args);
    }
  } catch {
    // Fallback for circular references or non-serializable objects
    normalized = String(args);
  }
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function checkForLoop(
  ctx: EmbeddedPiSubscribeContext,
  toolName: string,
  args: unknown,
): { isLoop: boolean; attemptCount: number } {
  const argsHash = hashToolArgs(args);
  const actionKey = `${toolName}:${argsHash}`;

  // Check if this action is already blocked
  if (ctx.state.blockedToolActions.has(actionKey)) {
    return { isLoop: true, attemptCount: LOOP_DETECTION_FAILURE_THRESHOLD };
  }

  // Clean up old history entries (outside time window)
  const now = Date.now();
  const cutoff = now - LOOP_DETECTION_TIME_WINDOW_MS;
  ctx.state.toolExecutionHistory = ctx.state.toolExecutionHistory.filter(
    (entry) => entry.timestamp > cutoff,
  );

  // Trim history to max size
  if (ctx.state.toolExecutionHistory.length > LOOP_DETECTION_HISTORY_SIZE) {
    ctx.state.toolExecutionHistory = ctx.state.toolExecutionHistory.slice(
      -LOOP_DETECTION_HISTORY_SIZE,
    );
  }

  // Count recent failures for this specific action
  const recentFailures = ctx.state.toolExecutionHistory.filter(
    (entry) =>
      entry.toolName === toolName && entry.argsHash === argsHash && entry.success === false,
  );

  const failureCount = recentFailures.length;

  // If we've hit the threshold, block this action
  if (failureCount >= LOOP_DETECTION_FAILURE_THRESHOLD) {
    ctx.state.blockedToolActions.add(actionKey);
    ctx.log.warn(
      `Loop detected: ${toolName} with args hash ${argsHash} failed ${failureCount} times. BLOCKING.`,
    );
    return { isLoop: true, attemptCount: failureCount };
  }

  return { isLoop: false, attemptCount: failureCount };
}

function recordToolExecution(
  ctx: EmbeddedPiSubscribeContext,
  toolName: string,
  args: unknown,
  success: boolean,
): void {
  const argsHash = hashToolArgs(args);
  ctx.state.toolExecutionHistory.push({
    toolName,
    argsHash,
    timestamp: Date.now(),
    success,
  });

  // Trim history to prevent memory leak
  if (ctx.state.toolExecutionHistory.length > LOOP_DETECTION_HISTORY_SIZE) {
    ctx.state.toolExecutionHistory = ctx.state.toolExecutionHistory.slice(
      -LOOP_DETECTION_HISTORY_SIZE,
    );
  }
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
  // Flush pending block replies to preserve message boundaries before tool execution.
  ctx.flushBlockReplyBuffer();
  if (ctx.params.onBlockReplyFlush) {
    void ctx.params.onBlockReplyFlush();
  }

  const rawToolName = String(evt.toolName);
  const toolName = normalizeToolName(rawToolName);
  const toolCallId = String(evt.toolCallId);
  const args = evt.args;

  // ── LOOP DETECTION: Check before execution ──────────────────────────────
  const loopCheck = checkForLoop(ctx, toolName, args);
  if (loopCheck.isLoop) {
    const argsHash = hashToolArgs(args);
    const interventionMessage = `SYSTEM INTERVENTION: Loop Detected.

You have attempted the tool "${toolName}" with identical arguments ${loopCheck.attemptCount} times, and it has failed each time.

This specific action is now BLOCKED to prevent infinite loops.

You MUST choose a different strategy:
- Use a different tool
- Modify the arguments significantly
- Verify the current state before proceeding
- Consider if the task is actually achievable

Do NOT retry this exact action again.`;

    ctx.log.warn(
      `LOOP BLOCKED: ${toolName} (hash: ${argsHash}) - injecting intervention message`,
    );

    // Emit tool start event (for consistency)
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
    void ctx.params.onAgentEvent?.({
      stream: "tool",
      data: { phase: "start", name: toolName, toolCallId },
    });

    // Immediately emit a synthetic error result
    const syntheticResult = {
      error: interventionMessage,
      text: interventionMessage,
      isError: true,
      loopDetected: true,
    };

    ctx.state.toolMetas.push({ toolName, meta: "LOOP BLOCKED" });
    ctx.state.lastToolError = {
      toolName,
      meta: "LOOP BLOCKED",
      error: interventionMessage,
    };

    const sanitizedResult = {
      error: interventionMessage,
      text: interventionMessage,
      isError: true,
      loopDetected: true,
    };

    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "tool",
      data: {
        phase: "result",
        name: toolName,
        toolCallId,
        meta: "LOOP BLOCKED",
        isError: true,
        result: sanitizedResult,
      },
    });
    void ctx.params.onAgentEvent?.({
      stream: "tool",
      data: {
        phase: "result",
        name: toolName,
        toolCallId,
        meta: "LOOP BLOCKED",
        isError: true,
      },
    });

    // Emit tool output if verbose (this makes it visible to the LLM)
    if (ctx.params.onToolResult && ctx.shouldEmitToolOutput()) {
      ctx.emitToolOutput(toolName, "LOOP BLOCKED", interventionMessage);
    } else if (ctx.params.onToolResult && ctx.shouldEmitToolResult()) {
      // Even in non-verbose mode, emit the intervention as a tool summary
      ctx.emitToolSummary(toolName, "LOOP BLOCKED");
    }

    // CRITICAL: Return early to prevent actual tool execution
    return;
  }

  if (toolName === "read") {
    const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const filePath = typeof record.path === "string" ? record.path.trim() : "";
    if (!filePath) {
      const argsPreview = typeof args === "string" ? args.slice(0, 200) : undefined;
      ctx.log.warn(
        `read tool called without path: toolCallId=${toolCallId} argsType=${typeof args}${argsPreview ? ` argsPreview=${argsPreview}` : ""}`,
      );
    }
  }

  const meta = extendExecMeta(toolName, args, inferToolMetaFromArgs(toolName, args));
  ctx.state.toolMetaById.set(toolCallId, meta);
  ctx.state.toolArgsById.set(toolCallId, args);
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

export function handleToolExecutionEnd(
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
  const isToolError = isError || isToolResultError(result);
  const sanitizedResult = sanitizeToolResult(result);
  const meta = ctx.state.toolMetaById.get(toolCallId);
  const args = ctx.state.toolArgsById.get(toolCallId);

  // ── LOOP DETECTION: Record execution result ─────────────────────────────
  const isLoopBlocked = meta === "LOOP BLOCKED";
  if (!isLoopBlocked && args !== undefined) {
    // Record this execution in history
    recordToolExecution(ctx, toolName, args, !isToolError);

    if (isToolError) {
      ctx.log.debug(`Tool execution failed: ${toolName} (will count toward loop detection)`);
    }
  }

  ctx.state.toolMetas.push({ toolName, meta });
  ctx.state.toolMetaById.delete(toolCallId);
  ctx.state.toolArgsById.delete(toolCallId);
  ctx.state.toolSummaryById.delete(toolCallId);
  if (isToolError && !isLoopBlocked) {
    const errorMessage = extractToolErrorMessage(sanitizedResult);
    ctx.state.lastToolError = {
      toolName,
      meta,
      error: errorMessage,
    };
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
}
