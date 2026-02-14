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
  extractToolResultText,
  extractMessagingToolSend,
  isToolResultError,
  sanitizeToolResult,
} from "./pi-embedded-subscribe.tools.js";
import { inferToolMetaFromArgs } from "./pi-embedded-utils.js";
import { normalizeToolName } from "./tool-policy.js";

/** Track tool execution start times and args for after_tool_call hook */
const toolStartData = new Map<string, { startTime: number; args: unknown }>();

const READ_ONLY_ACTIONS = new Set([
  "get",
  "list",
  "read",
  "status",
  "show",
  "fetch",
  "search",
  "query",
  "view",
  "poll",
  "log",
  "inspect",
  "check",
  "probe",
]);
const PROCESS_MUTATING_ACTIONS = new Set(["write", "send_keys", "submit", "paste", "kill"]);
const MESSAGE_MUTATING_ACTIONS = new Set([
  "send",
  "reply",
  "thread_reply",
  "threadreply",
  "edit",
  "delete",
  "react",
  "pin",
  "unpin",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function normalizeActionName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return normalized || undefined;
}

function normalizeFingerprintValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized ? normalized.toLowerCase() : undefined;
}

function isMutatingToolCall(toolName: string, args: unknown): boolean {
  const normalized = toolName.trim().toLowerCase();
  const record = asRecord(args);
  const action = normalizeActionName(record?.action);

  switch (normalized) {
    case "write":
    case "edit":
    case "apply_patch":
    case "exec":
    case "bash":
    case "sessions_send":
      return true;
    case "process":
      return action != null && PROCESS_MUTATING_ACTIONS.has(action);
    case "message":
      return (
        (action != null && MESSAGE_MUTATING_ACTIONS.has(action)) ||
        typeof record?.content === "string" ||
        typeof record?.message === "string"
      );
    case "session_status":
      return typeof record?.model === "string" && record.model.trim().length > 0;
    default: {
      if (normalized === "cron" || normalized === "gateway" || normalized === "canvas") {
        return action == null || !READ_ONLY_ACTIONS.has(action);
      }
      if (normalized === "nodes") {
        return action == null || action !== "list";
      }
      if (normalized.endsWith("_actions")) {
        return action == null || !READ_ONLY_ACTIONS.has(action);
      }
      if (normalized.startsWith("message_") || normalized.includes("send")) {
        return true;
      }
      return false;
    }
  }
}

function buildActionFingerprint(
  toolName: string,
  args: unknown,
  meta?: string,
): string | undefined {
  if (!isMutatingToolCall(toolName, args)) {
    return undefined;
  }
  const normalizedTool = toolName.trim().toLowerCase();
  const record = asRecord(args);
  const action = normalizeActionName(record?.action);
  const parts = [`tool=${normalizedTool}`];
  if (action) {
    parts.push(`action=${action}`);
  }
  for (const key of [
    "path",
    "filePath",
    "oldPath",
    "newPath",
    "to",
    "target",
    "messageId",
    "sessionKey",
    "jobId",
    "id",
    "model",
  ]) {
    const value = normalizeFingerprintValue(record?.[key]);
    if (value) {
      parts.push(`${key.toLowerCase()}=${value}`);
    }
  }
  const normalizedMeta = meta?.trim().replace(/\s+/g, " ").toLowerCase();
  if (normalizedMeta) {
    parts.push(`meta=${normalizedMeta}`);
  }
  return parts.join("|");
}

function buildToolCallSummary(toolName: string, args: unknown, meta?: string): ToolCallSummary {
  const actionFingerprint = buildActionFingerprint(toolName, args, meta);
  return {
    meta,
    mutatingAction: actionFingerprint != null,
    actionFingerprint,
  };
}

function sameToolAction(
  existing: { toolName: string; meta?: string; actionFingerprint?: string },
  toolName: string,
  meta?: string,
  actionFingerprint?: string,
): boolean {
  if (existing.actionFingerprint != null || actionFingerprint != null) {
    // For mutating flows, fail closed: only clear when both fingerprints exist and match.
    return (
      existing.actionFingerprint != null &&
      actionFingerprint != null &&
      existing.actionFingerprint === actionFingerprint
    );
  }
  return existing.toolName === toolName && (existing.meta ?? "") === (meta ?? "");
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

  // Track start time and args for after_tool_call hook
  toolStartData.set(toolCallId, { startTime: Date.now(), args });

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
      if (sameToolAction(ctx.state.lastToolError, toolName, meta, callSummary?.actionFingerprint)) {
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

  // Run after_tool_call plugin hook (fire-and-forget)
  const hookRunnerAfter = ctx.hookRunner ?? getGlobalHookRunner();
  if (hookRunnerAfter?.hasHooks("after_tool_call")) {
    const startData = toolStartData.get(toolCallId);
    toolStartData.delete(toolCallId);
    const durationMs = startData?.startTime != null ? Date.now() - startData.startTime : undefined;
    const toolArgs = startData?.args;
    const hookEvent: PluginHookAfterToolCallEvent = {
      toolName,
      params: (toolArgs && typeof toolArgs === "object" ? toolArgs : {}) as Record<string, unknown>,
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
  } else {
    toolStartData.delete(toolCallId);
  }
}
