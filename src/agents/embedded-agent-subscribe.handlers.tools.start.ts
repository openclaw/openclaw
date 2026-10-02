import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import {
  emitAgentActivityEvent,
  projectAgentToolActivity,
  type AgentItemEventData,
} from "../infra/agent-activity-events.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { readAutomationDisplayState } from "../infra/agent-run-registry.automation.js";
import { isAgentPlanProgressToolName } from "../session-cards/progress-card-input.js";
import { isDeliverableMessageChannel } from "../utils/message-channel-normalize.js";
import { resolveCompletedActivityWrappers } from "./agent-activity-presentation.js";
import { sanitizeForConsole } from "./console-sanitize.js";
import { runBestEffortCallback } from "./embedded-agent-subscribe.callback.js";
import type {
  ToolCallSummary,
  ToolHandlerContext,
} from "./embedded-agent-subscribe.handlers.types.js";
import type { AgentEvent } from "./runtime/index.js";
import { inferToolMetaFromArgsCore, isCommandBearingToolCall } from "./tool-display.js";
import { buildToolMutationState } from "./tool-mutation.js";
import { normalizeToolPolicyName } from "./tool-policy.js";
import {
  cancelAskUserPromptDelivery,
  normalizeAskUserParams,
  reserveAskUserPromptDelivery,
  settleAskUserPromptDelivery,
  waitForAskUserPromptReady,
} from "./tools/ask-user-tool.js";
import { sendQuestionToolPrompt } from "./tools/question-prompt-send.js";
import { normalizeSecretsRequestParams } from "./tools/secrets-tool.js";

function reserveQuestionPromptDelivery(
  toolName: "ask_user" | "secrets",
  toolCallId: string,
  sessionKey: string | undefined,
  runId: string,
  agentId: string | undefined,
  args: unknown,
) {
  try {
    const { questions, timeoutSeconds } =
      toolName === "secrets" ? normalizeSecretsRequestParams(args) : normalizeAskUserParams(args);
    return reserveAskUserPromptDelivery({
      toolCallId,
      sessionKey,
      runId,
      agentId,
      questions,
      timeoutSeconds,
    });
  } catch {
    // Argument validation owns malformed calls; do not deliver an unusable prompt first.
    return undefined;
  }
}

type ToolStartRecord = {
  startTime: number;
  args: unknown;
  hideFromChannelProgress?: boolean;
  parentToolCallId?: string;
  hasRepliedRef?: { value: boolean };
};

/** Track tool execution start data for after_tool_call hook. */
export const toolStartData = new Map<string, ToolStartRecord>();

export function buildToolStartKey(runId: string, toolCallId: string): string {
  return `${runId}:${toolCallId}`;
}

function* iterateRunToolStarts(runId: string) {
  const prefix = `${runId}:`;
  for (const entry of toolStartData) {
    if (entry[0].startsWith(prefix)) {
      yield entry;
    }
  }
}

export function countActiveToolExecutions(runId: string): number {
  const entries = iterateRunToolStarts(runId);
  let count = 0;
  while (!entries.next().done) {
    count += 1;
  }
  return count;
}

/** Cleans up tool start data for a run that has been unsubscribed or aborted. */
export function cleanupRunToolStartData(runId: string): void {
  for (const [key] of iterateRunToolStarts(runId)) {
    toolStartData.delete(key);
  }
}

export function buildToolCallSummary(
  toolName: string,
  args: unknown,
  meta: string | undefined,
  instanceReplaySafe: boolean,
  ownerKey: string | undefined,
  structuredReplaySafe: boolean,
): ToolCallSummary {
  const mutation = buildToolMutationState(toolName, args, ownerKey ? { ownerKey } : undefined);
  return {
    meta,
    commandBearing: isCommandBearingToolCall(toolName, args),
    instanceReplaySafe,
    ...(ownerKey ? { ownerKey } : {}),
    replaySafe:
      (instanceReplaySafe && !mutation.mutatingAction) ||
      (structuredReplaySafe && mutation.replaySafe),
  };
}

export function isExecToolName(toolName: string): boolean {
  return toolName === "exec" || toolName === "bash";
}

export function buildCommandItemId(toolCallId: string): string {
  return `command:${toolCallId}`;
}

export function buildCommandItemTitle(toolName: string, meta?: string): string {
  return meta ? `command ${meta}` : `${toolName} command`;
}

export function emitTrackedItemEvent(
  ctx: ToolHandlerContext,
  itemData: AgentItemEventData,
  emitLiveUpdate = true,
): void {
  if (itemData.phase === "start") {
    ctx.state.itemActiveIds.add(itemData.itemId);
    ctx.state.itemStartedCount += 1;
  }
  // Reply liveness and channel delivery still consume every original callback.
  if (itemData.phase !== "update" || emitLiveUpdate) {
    emitToolActivityEvent(ctx, { stream: "item", data: itemData });
  } else {
    emitAgentEventCallbackBestEffort(ctx, { stream: "item", data: itemData });
  }
}

export function emitAgentEventCallbackBestEffort(
  ctx: ToolHandlerContext,
  event: Parameters<NonNullable<ToolHandlerContext["params"]["onAgentEvent"]>>[0],
): void {
  runBestEffortCallback({
    label: "tool agent event",
    log: ctx.log,
    callback: () => ctx.params.onAgentEvent?.(event),
  });
}

type ActivityWithoutOwner<T = Parameters<typeof emitAgentActivityEvent>[0]> = T extends unknown
  ? Omit<T, "runId" | "sessionKey">
  : never;

export function emitToolActivityEvent(ctx: ToolHandlerContext, event: ActivityWithoutOwner): void {
  emitAgentActivityEvent({
    runId: ctx.params.runId,
    ...(ctx.params.sessionKey ? { sessionKey: ctx.params.sessionKey } : {}),
    ...event,
  });
  emitAgentEventCallbackBestEffort(ctx, { stream: event.stream, data: event.data });
}

export function finalizeToolActivity(ctx: ToolHandlerContext): void {
  const runId = ctx.params.runId;
  const active = [...iterateRunToolStarts(runId)].map(([key, start]) => ({
    runId: ctx.params.runId,
    callId: key.slice(runId.length + 1),
    parentToolCallId: start.parentToolCallId,
    activity: undefined,
  }));
  // Keyed active state cannot represent overlapping duplicate starts. Keep the
  // original summaries when lifecycle accounting cannot prove a complete graph.
  if (
    active.length !== ctx.state.itemActiveIds.size ||
    ctx.state.itemStartedCount !== ctx.state.itemCompletedCount + active.length ||
    ctx.state.toolMetas.length !== ctx.state.itemCompletedCount
  ) {
    return;
  }
  const calls = [
    ...ctx.state.toolMetas.map((meta) => ({
      runId: ctx.params.runId,
      callId: meta.toolCallId,
      parentToolCallId: meta.parentToolCallId,
      activity: meta.activity,
    })),
    ...active,
  ];
  for (const call of resolveCompletedActivityWrappers(calls)) {
    if (call.activity && !call.activity.hideFromChannelProgress) {
      emitToolActivityEvent(ctx, {
        stream: "item",
        data: { ...call.activity, hideFromChannelProgress: true },
      });
    }
  }
}

function extendExecMeta(toolName: string, args: unknown, meta?: string): string | undefined {
  if (!isExecToolName(toolName) || !args || typeof args !== "object") {
    return meta;
  }
  const record = args as Record<string, unknown>;
  const flags = ["pty", "elevated"].filter((flag) => record[flag] === true);
  if (flags.length === 0) {
    return meta;
  }
  const suffix = flags.join(" · ");
  return meta ? `${meta} · ${suffix}` : suffix;
}

export function handleToolExecutionStart(
  ctx: ToolHandlerContext,
  evt: AgentEvent & {
    toolName: string;
    toolCallId: string;
    args: unknown;
    replaySafe?: boolean;
    hideFromChannelProgress?: boolean;
    lifecycleProvenance?: "nested";
    parentToolCallId?: string;
  },
): void | Promise<void> {
  const startToolName = normalizeToolPolicyName(evt.toolName);
  ctx.state.liveEditDiffStateById.delete(evt.toolCallId);
  const isQuestionTool =
    startToolName === "ask_user" ||
    (startToolName === "secrets" &&
      evt.args !== null &&
      typeof evt.args === "object" &&
      "action" in evt.args &&
      evt.args.action === "request");
  const questionPromptReservation =
    isQuestionTool &&
    ctx.params.onToolResult &&
    // Native credential cards arrive through question.requested, not a public link.
    (startToolName === "ask_user" || isDeliverableMessageChannel(ctx.params.messageChannel ?? ""))
      ? reserveQuestionPromptDelivery(
          startToolName === "ask_user" ? "ask_user" : "secrets",
          evt.toolCallId,
          ctx.params.sessionKey,
          ctx.params.runId,
          ctx.params.agentId,
          evt.args,
        )
      : undefined;
  const cancelQuestionPromptReservation = () => {
    if (questionPromptReservation) {
      cancelAskUserPromptDelivery(
        evt.toolCallId,
        ctx.params.sessionKey,
        ctx.params.runId,
        ctx.params.agentId,
      );
    }
  };
  const flushBeforeStart = (
    flush: () => void | Promise<void>,
    next: () => void | Promise<void>,
  ): void | Promise<void> => {
    let result: void | Promise<void>;
    try {
      result = flush();
    } catch (error) {
      cancelQuestionPromptReservation();
      throw error;
    }
    if (isPromiseLike<void>(result)) {
      return result.then(next, (error: unknown) => {
        cancelQuestionPromptReservation();
        throw error;
      });
    }
    return next();
  };

  const continueToolExecutionStart = (): void | Promise<void> => {
    const rawToolName = evt.toolName;
    const toolName = normalizeToolPolicyName(rawToolName);
    const toolCallId = evt.toolCallId;
    const args = evt.args;
    const runId = ctx.params.runId;
    ctx.state.toolExecutionSinceLastBlockReply = true;
    runBestEffortCallback({
      label: "tool execution phase",
      log: ctx.log,
      callback: () =>
        ctx.params.onExecutionPhase?.({
          phase: "tool_execution_started",
          tool: toolName,
          toolCallId,
          source: "embedded-agent",
        }),
    });

    const startedAt = Date.now();
    toolStartData.set(buildToolStartKey(runId, toolCallId), {
      startTime: startedAt,
      args,
      hideFromChannelProgress: evt.hideFromChannelProgress,
      parentToolCallId: evt.parentToolCallId,
      ...(ctx.params.hasRepliedRef
        ? { hasRepliedRef: { value: ctx.params.hasRepliedRef.value } }
        : {}),
    });

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
        const argsType = typeof args;
        const safeRunId = sanitizeForConsole(runId) ?? "-";
        const safeSessionKey = sanitizeForConsole(ctx.params.sessionKey);
        const safeSessionId = sanitizeForConsole(ctx.params.sessionId);
        const safeAgentId = sanitizeForConsole(ctx.params.agentId);
        const consoleMessageParts = [
          "read tool called without path:",
          `runId=${safeRunId}`,
          `toolCallId=${sanitizeForConsole(toolCallId) ?? "tool-call"}`,
          `argsType=${argsType}`,
        ];
        if (safeSessionKey) {
          consoleMessageParts.push(`sessionKey=${safeSessionKey}`);
        }
        if (safeSessionId) {
          consoleMessageParts.push(`sessionId=${safeSessionId}`);
        }
        if (safeAgentId) {
          consoleMessageParts.push(`agentId=${safeAgentId}`);
        }
        const consoleMessage = consoleMessageParts.join(" ");
        const message = `read tool called without path: toolCallId=${toolCallId} argsType=${argsType}`;
        ctx.log.warn(message, {
          event: "embedded_read_tool_start_warning",
          tags: ["tool_start", "read", "embedded", "validation"],
          runId: ctx.params.runId,
          toolCallId,
          argsType,
          ...(safeSessionKey ? { sessionKey: ctx.params.sessionKey } : {}),
          ...(safeSessionId ? { sessionId: ctx.params.sessionId } : {}),
          ...(safeAgentId ? { agentId: ctx.params.agentId } : {}),
          consoleMessage,
        });
      }
    }

    const meta = extendExecMeta(
      toolName,
      args,
      inferToolMetaFromArgsCore(toolName, args, {
        detailMode: ctx.params.toolProgressDetail ?? "explain",
      }),
    );
    const instanceReplaySafe =
      evt.replaySafe === true ||
      ctx.params.replaySafeToolNames?.has(rawToolName) === true ||
      ctx.params.replaySafeToolNames?.has(toolName) === true;
    const callSummary = buildToolCallSummary(
      toolName,
      args,
      meta,
      instanceReplaySafe,
      ctx.params.sideEffectToolOwners?.get(toolName),
      false,
    );
    ctx.state.toolMetaById.set(toolCallId, callSummary);

    const shouldEmitToolEvents = ctx.shouldEmitToolResult();
    const hideFromChannelProgress =
      evt.hideFromChannelProgress === true || readAutomationDisplayState(runId) !== "ordinary";
    const itemData = {
      ...projectAgentToolActivity({
        toolCallId,
        name: toolName,
        phase: "start",
        args,
        meta,
        hideFromChannelProgress,
      }),
      startedAt,
    };
    emitTrackedItemEvent(ctx, itemData);
    const createStartEvent = () => ({
      stream: "tool" as const,
      data: {
        phase: "start",
        name: toolName,
        toolCallId,
        ...(evt.parentToolCallId ? { parentToolCallId: evt.parentToolCallId } : {}),
        args: asOptionalObjectRecord(args),
        ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
      },
    });
    emitAgentEvent({ runId: ctx.params.runId, ...createStartEvent() });
    // Best-effort typing signal; do not block tool summaries on slow emitters.
    emitAgentEventCallbackBestEffort(ctx, createStartEvent());

    if (
      ctx.params.onToolResult &&
      shouldEmitToolEvents &&
      !hideFromChannelProgress &&
      !isAgentPlanProgressToolName(toolName) &&
      !ctx.state.toolSummaryById.has(toolCallId)
    ) {
      ctx.state.toolSummaryById.add(toolCallId);
      ctx.emitToolSummary(toolName, meta, callSummary.commandBearing);
    }

    const publishPrompt = ctx.params.onToolResult;
    if (questionPromptReservation && publishPrompt) {
      const questionId = questionPromptReservation.questionId;
      void waitForAskUserPromptReady(questionId)
        .then(async (questions) => {
          if (!questions) {
            return;
          }
          await sendQuestionToolPrompt({
            toolName: toolName === "secrets" ? "secrets" : "ask_user",
            questionId,
            questions,
            config: ctx.params.config,
            send: publishPrompt,
          });
        })
        .then(
          () => settleAskUserPromptDelivery(questionId),
          (error: unknown) => {
            settleAskUserPromptDelivery(questionId, error);
            ctx.log.warn(`failed to deliver ${toolName} prompt: ${String(error)}`);
          },
        );
    }
  };

  // Only the outer provider tool owns the block-reply presentation boundary.
  if (evt.lifecycleProvenance === "nested") {
    return continueToolExecutionStart();
  }
  return flushBeforeStart(
    () => ctx.flushBlockReplyBuffer(),
    () =>
      flushBeforeStart(
        () =>
          ctx.params.onBlockReplyFlush?.({
            reason: "tool_start",
            assistantMessageIndex: ctx.state.assistantMessageIndex,
          }),
        continueToolExecutionStart,
      ),
  );
}
