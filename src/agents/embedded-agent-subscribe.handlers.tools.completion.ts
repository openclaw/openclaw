import { asOptionalObjectRecord, asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { projectAgentToolActivity } from "../infra/agent-activity-events.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { readAutomationDisplayState } from "../infra/agent-run-registry.automation.js";
import type { PluginHookAfterToolCallEvent } from "../plugins/types.js";
import { projectProgressCardChannelUpdate } from "../session-cards/progress-card-channel-summary.js";
import { normalizeAcceptedSessionSpawnResult } from "./accepted-session-spawn.js";
import {
  consumeAdjustedParamsForToolCall,
  consumePreExecutionBlockedToolCall,
  consumeStructuredReplaySafeToolCall,
  consumeTrackedToolExecutionStarted,
} from "./agent-tools.before-tool-call.state.js";
import { normalizeTextForComparison } from "./embedded-agent-helpers/messaging-dedupe.js";
import {
  isDeliveredCoreCurrentChannelWidgetResult,
  readEmbeddedMessageDeliveryFact,
} from "./embedded-agent-message-delivery.js";
import {
  isDeliveredMessageToolOnlySourceReplyResult,
  isDeliveredMessagingToolResult,
  readMessageToolSourceReplyText,
  resolveMessageToolSourceReplyFinal,
} from "./embedded-agent-message-tool-source-reply.js";
import {
  extractMessagingToolSend,
  extractMessagingToolSendResult,
  extractMessagingToolSourceReplyPayload,
  isDeliveredMessagingToolSendToCurrentSource,
} from "./embedded-agent-messaging-extraction.js";
import {
  isMessagingTool,
  isPluginNativeMessagingTool,
  isMessagingToolSendAction,
  isMessagingToolTargetEvidenceAction,
} from "./embedded-agent-messaging.js";
import { mergeEmbeddedRunReplayState } from "./embedded-agent-runner/replay-state.js";
import {
  applyCurrentMessageProvider,
  applyToolSendReceiptForExtraction,
  buildPatchSummaryText,
  buildProcessTerminalDiagnostic,
  didShellCronAddSucceed,
  emitToolResultOutput,
  extractExecOutput,
  extractLiveExecOutput,
  hasMessagingRichContent,
  isMiddlewareToolResultError,
  loadHookRunnerGlobal,
  readApplyPatchSummary,
  readExecToolDetails,
  readMessagingText,
  resolveFallbackToolTerminalObserver,
} from "./embedded-agent-subscribe.handlers.tools.results.js";
import {
  buildCommandItemId,
  buildCommandItemTitle,
  buildToolCallSummary,
  buildToolStartKey,
  emitAgentEventCallbackBestEffort,
  emitToolActivityEvent,
  isExecToolName,
  toolStartData,
} from "./embedded-agent-subscribe.handlers.tools.start.js";
import type { ToolHandlerContext } from "./embedded-agent-subscribe.handlers.types.js";
import {
  collectMessagingMediaUrlsFromRecord,
  collectMessagingMediaUrlsFromToolResult,
} from "./embedded-agent-tool-media.js";
import {
  capLiveExecResult,
  extractToolErrorCode,
  extractToolErrorMessage,
  isAsyncStartedToolResult,
  isToolResultTimedOut,
  readAsyncStartedTaskIds,
} from "./embedded-agent-tool-results.js";
import { parseExecApprovalResultText } from "./exec-approval-result.js";
import { isCronAddAction } from "./harness/tool-result-facts.js";
import { readMcpConnectAction } from "./mcp-connect-action.js";
import { readMcpAppChannelView } from "./mcp-ui-resource.js";
import type { AgentEvent } from "./runtime/index.js";
import {
  createToolValidationErrorSummary,
  hasTerminalControlCharacter,
  summarizeToolValidationError,
} from "./tool-error-summary.js";
import { resolveFileMutationToolName } from "./tool-mutation-names.js";
import { normalizeToolPolicyName } from "./tool-policy.js";
import {
  isToolResultError,
  readToolResultDetails,
  resolveToolResultHookOutcome,
} from "./tool-result-error.js";
import { cancelAskUserPromptDelivery } from "./tools/ask-user-tool.js";
import { isAutomationsToolName } from "./tools/automations-tool-name.js";

/** Capture semantic outcome immediately; nested callers publish after activity acceptance. */
export async function prepareToolExecutionEnd(
  ctx: ToolHandlerContext,
  evt: Extract<AgentEvent, { type: "tool_execution_end" }>,
  readResult: () => unknown,
) {
  const toolName = normalizeToolPolicyName(evt.toolName);
  const toolCallId = evt.toolCallId;
  ctx.state.liveEditDiffStateById.delete(toolCallId);
  if (toolName === "ask_user") {
    cancelAskUserPromptDelivery(toolCallId, ctx.params.sessionKey, ctx.params.runId);
  }
  const runId = ctx.params.runId;
  const result = evt.result;
  const toolSendReceiptResult = ctx.consumeToolSendReceipt?.(toolCallId);
  const observerIsError = evt.isError || isToolResultError(result);
  const sanitizedResult = readResult();
  const approvalUnavailable =
    isExecToolName(toolName) &&
    readExecToolDetails(sanitizedResult)?.status === "approval-unavailable";
  const isToolError = observerIsError && !approvalUnavailable;
  if (!isToolError) {
    const channelView = readMcpAppChannelView(result);
    if (channelView) {
      // A later successful app result supersedes the earlier launch target.
      ctx.state.latestMcpAppChannelView = channelView;
    }
    const connectAction = readMcpConnectAction(result);
    if (connectAction) {
      ctx.state.latestMcpConnectAction = connectAction;
    }
  }
  try {
    ctx.params.onAgentToolResult?.({
      toolName,
      result: sanitizedResult,
      isError: observerIsError,
    });
  } catch (error) {
    ctx.log.warn(`onAgentToolResult handler failed: tool=${toolName} error=${String(error)}`);
  }
  const eventResult = isExecToolName(toolName)
    ? capLiveExecResult(sanitizedResult)
    : sanitizedResult;
  const toolStartKey = buildToolStartKey(runId, toolCallId);
  const startData = toolStartData.get(toolStartKey);
  toolStartData.delete(toolStartKey);
  ctx.state.execLiveUpdateStateById?.delete(toolCallId);
  const initialCallSummary = ctx.state.toolMetaById.get(toolCallId);
  const initialArgs = asRecord(startData?.args);
  const adjustedArgs = consumeAdjustedParamsForToolCall(toolCallId, runId);
  const trackedExecutionStarted = consumeTrackedToolExecutionStarted(toolCallId, runId);
  const executionPrevented = consumePreExecutionBlockedToolCall(toolCallId, runId);
  const structuredReplaySafe = consumeStructuredReplaySafeToolCall(toolCallId, runId);
  const startArgs = asOptionalObjectRecord(adjustedArgs) ?? initialArgs;
  const explicitHideFromChannelProgress =
    evt.hideFromChannelProgress === true || startData?.hideFromChannelProgress === true;
  const callSummary = buildToolCallSummary(
    toolName,
    startArgs,
    initialCallSummary?.meta,
    initialCallSummary?.instanceReplaySafe === true,
    initialCallSummary?.ownerKey,
    structuredReplaySafe,
  );
  // A racing observer can consume the active wrapper boundary. Settled and
  // custom producers use their terminal fact, while policy blocks override it.
  const executionStarted =
    (trackedExecutionStarted ?? evt.executionStarted ?? true) && !executionPrevented;
  const meta = callSummary.meta;
  const asyncStarted = !isToolError && isAsyncStartedToolResult(sanitizedResult);
  const asyncTaskIds = asyncStarted ? readAsyncStartedTaskIds(sanitizedResult) : {};
  // A Code Mode exec that returns "waiting" parked a run the model resumes via
  // `wait`; record that here so recovery can tell parked nested work apart
  // from any other still-active lifecycle item.
  const codeModeSuspended =
    !isToolError &&
    ctx.params.codeModeExecToolNames?.has(toolName) === true &&
    readToolResultDetails(sanitizedResult)?.status === "waiting";
  const resultRecord = asOptionalObjectRecord(result);
  const terminate =
    resultRecord !== undefined && "terminate" in resultRecord && resultRecord.terminate === true;
  const terminalMeta: (typeof ctx.state.toolMetas)[number] = {
    toolName,
    toolCallId,
    ...(startData?.parentToolCallId ? { parentToolCallId: startData.parentToolCallId } : {}),
    meta,
    replaySafe: !executionStarted || callSummary.replaySafe,
    isError: observerIsError,
    ...(terminate ? { terminate: true } : {}),
    ...(asyncStarted ? { asyncStarted: true, ...asyncTaskIds } : {}),
    ...(codeModeSuspended ? { codeModeSuspended: true } : {}),
  };
  ctx.state.toolMetas.push(terminalMeta);
  const acceptedSessionSpawn =
    toolName === "sessions_spawn" && !isToolError
      ? normalizeAcceptedSessionSpawnResult(sanitizedResult)
      : null;
  if (acceptedSessionSpawn) {
    ctx.state.acceptedSessionSpawns.push(acceptedSessionSpawn);
  }
  ctx.state.toolMetaById.delete(toolCallId);
  ctx.state.toolSummaryById.delete(toolCallId);
  const errorMessage = isToolError ? extractToolErrorMessage(sanitizedResult) : undefined;
  const errorCode = isToolError ? extractToolErrorCode(sanitizedResult) : undefined;
  const terminalDiagnostic = isToolError
    ? buildProcessTerminalDiagnostic(toolName, startArgs, sanitizedResult)
    : undefined;
  const terminalErrorMessage =
    terminalDiagnostic && errorMessage && hasTerminalControlCharacter(errorMessage)
      ? undefined
      : errorMessage;
  const validationErrorSummary =
    isToolError && evt.executionStarted === false && evt.errorKind === "argument-validation"
      ? createToolValidationErrorSummary(toolName)
      : undefined;
  const terminal = (ctx.params.observeToolTerminal ?? resolveFallbackToolTerminalObserver(ctx))({
    toolCallId,
    toolName,
    arguments: startArgs,
    result,
    ...(meta ? { meta } : {}),
    executionStarted,
    replaySafe: callSummary.replaySafe,
    outcome: isToolError ? "failure" : "success",
    ...(callSummary.ownerKey
      ? {
          ownerMutation: { ownerKey: callSummary.ownerKey },
        }
      : {}),
    ...(isToolError
      ? {
          failure: {
            ...(errorCode ? { errorCode } : {}),
            ...(terminalErrorMessage ? { error: terminalErrorMessage } : {}),
            ...(terminalDiagnostic ? { terminalDiagnostic } : {}),
            ...(validationErrorSummary ? { validationErrorSummary } : {}),
            timedOut: isToolResultTimedOut(sanitizedResult) || undefined,
            middlewareError: isMiddlewareToolResultError(sanitizedResult) || undefined,
          },
        }
      : {}),
  });
  ctx.state.lastToolError = terminal.lastToolError;
  const terminalErrorStatus = terminal.executionStarted ? "failed" : "blocked";
  const toolErrorSummary = ctx.state.lastToolError
    ? summarizeToolValidationError(ctx.state.lastToolError)
    : undefined;
  if (asyncStarted) {
    ctx.state.hadDeterministicSideEffect = true;
  }
  if (terminal.sideEffectEvidence || acceptedSessionSpawn || asyncStarted) {
    ctx.state.replayState = mergeEmbeddedRunReplayState(ctx.state.replayState, {
      replayInvalid: true,
      hadPotentialSideEffects: true,
    });
  }

  const messagingArgs = applyCurrentMessageProvider(toolName, startArgs, ctx.params.messageChannel);
  const isMessagingInvocation = isMessagingTool(toolName);
  const isMessagingSend = isMessagingInvocation && isMessagingToolSendAction(toolName, startArgs);
  const hasMessagingTargetEvidence =
    isMessagingInvocation && isMessagingToolTargetEvidenceAction(toolName, startArgs);
  const messageDelivery = readEmbeddedMessageDeliveryFact(
    readToolResultDetails(toolSendReceiptResult)?.messageDelivery,
  );
  // Embedded receipt capture omits core conversation statuses; presentation can rewrite them.
  const didDeliverMessagingResult =
    isMessagingInvocation &&
    (messageDelivery
      ? messageDelivery.status === "settled" && (!isToolError || messageDelivery.partialDelivery)
      : isPluginNativeMessagingTool(toolName) &&
        isDeliveredMessagingToolResult({
          toolName,
          args: startArgs,
          result,
          hookResult: toolSendReceiptResult,
          isError: isToolError,
        }));
  const messageText = isMessagingSend ? readMessagingText(startArgs) : undefined;
  const argumentMediaUrls = isMessagingSend ? collectMessagingMediaUrlsFromRecord(startArgs) : [];
  const hasRichContent = isMessagingSend && hasMessagingRichContent(startArgs);
  const messageTarget = hasMessagingTargetEvidence
    ? extractMessagingToolSend(toolName, messagingArgs, {
        config: ctx.params.config,
        currentChannelId: ctx.params.currentChannelId,
        currentMessagingTarget: ctx.params.currentMessagingTarget,
        currentThreadId: ctx.params.currentThreadId,
        currentMessageId: ctx.params.currentMessageId,
        replyToMode: ctx.params.replyToMode,
        hasRepliedRef: startData?.hasRepliedRef,
      })
    : undefined;
  const committedMediaUrls =
    didDeliverMessagingResult && isMessagingSend
      ? [...argumentMediaUrls, ...collectMessagingMediaUrlsFromToolResult(result)]
      : [];
  const extractionResult = applyToolSendReceiptForExtraction(result, toolSendReceiptResult);
  const confirmedMessageTarget =
    messageTarget && extractMessagingToolSendResult(messageTarget, extractionResult);
  const deliveredMessageToolSourceReply =
    didDeliverMessagingResult &&
    isDeliveredMessageToolOnlySourceReplyResult({
      sourceReplyDeliveryMode: ctx.params.sourceReplyDeliveryMode,
      toolName,
      args: startArgs,
      result,
      hookResult: toolSendReceiptResult,
      isError: isToolError,
      allowExplicitSourceRoute: isDeliveredMessagingToolSendToCurrentSource({
        send: confirmedMessageTarget,
        config: ctx.params.config,
        currentProvider: ctx.params.messageChannel,
        currentAccountId: ctx.params.currentAccountId,
        currentChannelId: ctx.params.currentChannelId,
        currentMessagingTarget: ctx.params.currentMessagingTarget,
        currentThreadId: ctx.params.currentThreadId,
        sessionKey: ctx.params.sessionKey,
        deliveredPayload: extractionResult,
      }),
      deliveryConfirmed: didDeliverMessagingResult,
    });
  const deliveredCurrentSourceReply =
    deliveredMessageToolSourceReply ||
    isDeliveredCoreCurrentChannelWidgetResult({
      coreBuiltinToolNames: ctx.params.coreBuiltinToolNames,
      sourceReplyDeliveryMode: ctx.params.sourceReplyDeliveryMode,
      toolName,
      result,
      isToolError,
    });
  const sourceReplyFinal =
    deliveredMessageToolSourceReply || messageDelivery?.sourceReplyDelivered
      ? resolveMessageToolSourceReplyFinal(startArgs, ctx.params.messageToolFinalByDefault)
      : undefined;
  ctx.state.sourceReplyDelivered ||= messageDelivery?.sourceReplyDelivered;
  if (
    sourceReplyFinal !== false &&
    (messageDelivery?.sourceReplyDelivered || deliveredCurrentSourceReply)
  ) {
    ctx.state.sourceReplyDeliveryState = "delivered";
  }
  if (didDeliverMessagingResult && messageText) {
    ctx.state.messagingToolSentTexts.push(messageText);
    ctx.state.messagingToolSentTextsNormalized.push(normalizeTextForComparison(messageText));
    ctx.trimMessagingToolSent();
  }
  if (didDeliverMessagingResult && confirmedMessageTarget) {
    ctx.state.messagingToolSentTargets.push({
      ...confirmedMessageTarget,
      ...(messageText ? { text: messageText } : {}),
      ...(committedMediaUrls.length > 0 ? { mediaUrls: committedMediaUrls.slice() } : {}),
      ...(hasRichContent ? { hasRichContent: true as const } : {}),
      ...(sourceReplyFinal !== undefined ? { sourceReplyFinal } : {}),
    });
    ctx.trimMessagingToolSent();
  }
  if (deliveredCurrentSourceReply) {
    ctx.state.messageToolOnlySourceReplyDelivered = true;
    if (deliveredMessageToolSourceReply) {
      const sourceReplyText = readMessageToolSourceReplyText(startArgs);
      const normalizedSourceReplyText = sourceReplyText
        ? normalizeTextForComparison(sourceReplyText)
        : "";
      if (normalizedSourceReplyText) {
        ctx.state.currentSourceMessagingToolSentTextsNormalized.push(normalizedSourceReplyText);
        ctx.trimMessagingToolSent();
      }
    }
    ctx.params.onDeliveredMessageToolOnlySourceReply?.();
  }
  if (didDeliverMessagingResult && isMessagingSend) {
    if (committedMediaUrls.length > 0) {
      ctx.state.messagingToolSentMediaUrls.push(...committedMediaUrls);
      ctx.trimMessagingToolSent();
    }
    const sourceReplyPayload = extractMessagingToolSourceReplyPayload(result);
    if (sourceReplyPayload) {
      ctx.state.messagingToolSourceReplyPayloads.push({
        ...sourceReplyPayload,
        ...(sourceReplyFinal !== undefined ? { sourceReplyFinal } : {}),
      });
      ctx.trimMessagingToolSent();
    }
  }
  ctx.state.turnToolsOnlySourceProgress =
    (ctx.state.turnToolsOnlySourceProgress ?? true) &&
    sourceReplyFinal === false &&
    isMessagingSend &&
    !isToolError &&
    !messageDelivery?.partialDelivery;
  ctx.state.lastToolTurnOnlySourceProgress = ctx.state.turnToolsOnlySourceProgress;
  // Track committed reminders only when cron.add completed successfully.
  if (
    !isToolError &&
    ((isAutomationsToolName(toolName) && isCronAddAction(startArgs)) ||
      (isExecToolName(toolName) && didShellCronAddSucceed(startArgs, result)))
  ) {
    ctx.state.successfulCronAdds += 1;
  }
  const planUpdate =
    !isToolError && toolName === "progress_card"
      ? projectProgressCardChannelUpdate(startArgs)
      : undefined;
  const endedAt = Date.now();
  const execDetails = readExecToolDetails(sanitizedResult);
  // A routine check has no activity bubble, but errors and approval requests still surface.
  const hideFromChannelProgress =
    explicitHideFromChannelProgress ||
    (readAutomationDisplayState(runId) !== "ordinary" &&
      !isToolError &&
      execDetails?.status !== "approval-pending" &&
      execDetails?.status !== "approval-unavailable");
  const itemData = {
    ...projectAgentToolActivity({
      toolCallId,
      name: toolName,
      phase: "result",
      args: startArgs,
      meta,
      result: sanitizedResult,
      status: isToolError ? terminalErrorStatus : "completed",
      hideFromChannelProgress,
    }),
    startedAt: startData?.startTime,
    endedAt,
    ...(errorMessage ? { error: errorMessage } : {}),
  };
  // Activity acceptance can suppress presentation, but the tool has settled.
  ctx.state.itemActiveIds.delete(itemData.itemId);
  ctx.state.itemCompletedCount += 1;
  const createResultData = () => ({
    phase: "result",
    name: toolName,
    toolCallId,
    ...(startData?.parentToolCallId ? { parentToolCallId: startData.parentToolCallId } : {}),
    meta,
    isError: isToolError,
    commandBearing: callSummary.commandBearing,
    ...(toolErrorSummary ? { toolErrorSummary } : {}),
    ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
  });

  // Run after_tool_call plugin hook (fire-and-forget)
  const hookRunnerAfter = ctx.hookRunner ?? (await loadHookRunnerGlobal()).getGlobalHookRunner();
  if (hookRunnerAfter?.hasHooks("after_tool_call")) {
    const durationMs = startData?.startTime != null ? Date.now() - startData.startTime : undefined;
    const outcome = resolveToolResultHookOutcome(sanitizedResult);
    const hookEvent: PluginHookAfterToolCallEvent = {
      toolName,
      params: adjustedArgs === undefined ? startArgs : structuredClone(startArgs),
      runId,
      toolCallId,
      result: sanitizedResult,
      error: isToolError ? extractToolErrorMessage(sanitizedResult) : undefined,
      durationMs,
      ...(outcome ? { outcome } : {}),
    };
    void hookRunnerAfter
      .runAfterToolCall(hookEvent, {
        toolName,
        agentId: ctx.params.agentId,
        sessionKey: ctx.params.sessionKey,
        sessionId: ctx.params.sessionId,
        runId,
        toolCallId,
      })
      .catch((err: unknown) => {
        ctx.log.warn(`after_tool_call hook failed: tool=${toolName} error=${String(err)}`);
      });
  }
  terminal.executedArguments ??= startArgs;
  let presentation: Promise<void> | undefined;
  const publishPresentation = () => (presentation ??= publish());
  return Object.assign(terminal, { isError: observerIsError, publishPresentation });

  async function publish(): Promise<void> {
    if (planUpdate) {
      const planEvent = {
        stream: "plan" as const,
        data: {
          phase: "update",
          title: "Plan updated",
          source: "openclaw",
          ...planUpdate,
        },
      };
      emitAgentEvent({ runId: ctx.params.runId, ...planEvent });
      emitAgentEventCallbackBestEffort(ctx, planEvent);
    }

    terminalMeta.activity = itemData;
    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "tool",
      data: {
        ...createResultData(),
        result: eventResult,
      },
    });
    emitToolActivityEvent(ctx, { stream: "item", data: itemData });
    emitAgentEventCallbackBestEffort(ctx, {
      stream: "tool",
      data: createResultData(),
    });

    if (isExecToolName(toolName)) {
      const commandItemId = buildCommandItemId(toolCallId);
      if (
        execDetails?.status === "approval-pending" ||
        execDetails?.status === "approval-unavailable"
      ) {
        const approvalStatus =
          execDetails.status === "approval-pending" ? "pending" : "unavailable";
        emitToolActivityEvent(ctx, {
          stream: "approval",
          data: {
            phase: "requested",
            kind: "exec",
            status: approvalStatus,
            title:
              approvalStatus === "pending"
                ? "Command approval requested"
                : "Command approval unavailable",
            itemId: commandItemId,
            toolCallId,
            ...(execDetails.status === "approval-pending"
              ? {
                  approvalId: execDetails.approvalId,
                  approvalSlug: execDetails.approvalSlug,
                }
              : {}),
            command: execDetails.command,
            host: execDetails.host,
            ...(execDetails.status === "approval-unavailable"
              ? { reason: execDetails.reason }
              : {}),
            message: execDetails.warningText,
          },
        });
      } else {
        const output = extractLiveExecOutput(sanitizedResult);
        const rawOutput = extractExecOutput(sanitizedResult);
        const commandStatus =
          execDetails?.status === "failed" || isToolError ? terminalErrorStatus : "completed";
        emitToolActivityEvent(ctx, {
          stream: "command_output",
          data: {
            itemId: commandItemId,
            phase: "end",
            title: buildCommandItemTitle(toolName, meta),
            toolCallId,
            name: toolName,
            ...(output ? { output } : {}),
            status: commandStatus,
            ...(execDetails && "exitCode" in execDetails ? { exitCode: execDetails.exitCode } : {}),
            ...(execDetails &&
            "durationMs" in execDetails &&
            typeof execDetails.durationMs === "number" &&
            Number.isFinite(execDetails.durationMs) &&
            execDetails.durationMs >= 0
              ? { durationMs: execDetails.durationMs }
              : {}),
            ...(execDetails && "cwd" in execDetails && typeof execDetails.cwd === "string"
              ? { cwd: execDetails.cwd }
              : {}),
          },
        });

        if (typeof rawOutput === "string") {
          const parsedApprovalResult = parseExecApprovalResultText(rawOutput);
          if (parsedApprovalResult.kind === "denied") {
            emitToolActivityEvent(ctx, {
              stream: "approval",
              data: {
                phase: "resolved",
                kind: "exec",
                status: normalizeOptionalLowercaseString(parsedApprovalResult.metadata)?.includes(
                  "approval-request-failed",
                )
                  ? "failed"
                  : "denied",
                title: "Command approval resolved",
                itemId: commandItemId,
                toolCallId,
                message: parsedApprovalResult.body || parsedApprovalResult.raw,
              },
            });
          }
        }
      }
    }

    if (resolveFileMutationToolName(toolName) === "apply_patch") {
      const patchSummary = readApplyPatchSummary(sanitizedResult);
      const patchItemId = `patch:${toolCallId}`;
      if (patchSummary) {
        emitToolActivityEvent(ctx, {
          stream: "patch",
          data: {
            itemId: patchItemId,
            phase: "end",
            title: meta ? `patch ${meta}` : "apply patch",
            toolCallId,
            name: toolName,
            added: patchSummary.added,
            modified: patchSummary.modified,
            deleted: patchSummary.deleted,
            summary: buildPatchSummaryText(patchSummary),
          },
        });
      }
    }

    if (!planUpdate) {
      await emitToolResultOutput({
        ctx,
        toolName,
        rawToolName: evt.toolName,
        meta,
        isToolError,
        result,
        sanitizedResult,
      });
    }
    await Promise.resolve(ctx.params.onToolStreamBoundary?.()).catch((error: unknown) => {
      ctx.log.debug(`embedded run tool stream boundary callback failed: ${String(error)}`);
    });
  }
}

/** Ordinary provider tool results have no separate nested-activity commit boundary. */
export async function handleToolExecutionEnd(
  ctx: ToolHandlerContext,
  evt: Extract<AgentEvent, { type: "tool_execution_end" }>,
  readResult: () => unknown,
) {
  const terminal = await prepareToolExecutionEnd(ctx, evt, readResult);
  await terminal.publishPresentation();
  return terminal;
}
