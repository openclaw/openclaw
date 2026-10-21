import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { hasCompletionMessageSessionSpawn } from "../accepted-session-spawn.js";
import {
  filterAgentRunTerminalPayloadsForPresentation,
  sanitizeAgentRunTerminalReply,
} from "../agent-run-terminal-reply.js";
import {
  externalCliDiscoveryForProviderAuth,
  loadAuthProfileStoreForRuntimeAsync,
  markAuthProfileFailure,
  markAuthProfileSuccess,
  type AuthProfileStore,
} from "../auth-profiles.js";
import type { CliOutput, CliTerminalInterruption } from "../cli-output-contracts.js";
import {
  shouldClearFailedCliSessionBinding,
  shouldClearInterruptedCliSessionBinding,
} from "../cli-session.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent-runner.js";
import {
  hasCompletedSourceReplyDeliveryEvidence,
  resolveExplicitFinalSourceReplyDeliveryEvidence,
} from "../embedded-agent-runner/delivery-evidence.js";
import { resolveAuthProfileFailureReason } from "../embedded-agent-runner/run/auth-profile-failure-policy.js";
import { mergeAttemptToolMediaPayloads } from "../embedded-agent-runner/run/tool-media-payloads.js";
import { isFailoverError } from "../failover-error.js";
import {
  createMissingReplyNotice,
  MISSING_REPLY_NOTICE_TEXT,
  resolveReplyCompletion,
  resolveReplyExpectation,
  shouldDeliverMissingReplyNotice,
} from "../reply-completion.js";
import { recordAgentCleanupFailure } from "../run-cleanup-timeout.js";
import { CliAuthProfilePreparationError } from "./auth-profile-preparation-error.js";
import { runCliCleanup } from "./cleanup.js";
import { resolveCliSessionId } from "./cli-run-recovery.js";
import { projectCliMessagingDeliveryEvidence } from "./delivery-evidence.js";
import { hashCliReseedPrompt } from "./reseed-envelope.js";
import type { ClaudeCliRunDiagnosticLifecycle } from "./run-diagnostics.js";
import { resolveCliSourceReplyMirror, type PreparedCliRunTerminalReply } from "./terminal-reply.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";

const log = createSubsystemLogger("agents/cli-runner");

/** Formats the visible terminal reason for an interrupted turn that retained partial output. */
export function formatCliTerminalInterruption(interruption: CliTerminalInterruption): string {
  return `CLI turn ${interruption.reason} after partial output`;
}

async function settleCliAuthProfile(params: {
  store: AuthProfileStore;
  profileId: string;
  provider: string;
  agentDir?: string;
  terminal:
    | { outcome: "success"; modelId?: string }
    | {
        outcome: "failure";
        error: unknown;
        config?: RunCliAgentParams["config"];
        runId: string;
        modelId?: string;
      };
}): Promise<void> {
  try {
    if (params.terminal.outcome === "success") {
      await markAuthProfileSuccess({
        store: params.store,
        profileId: params.profileId,
        provider: params.provider,
        modelId: params.terminal.modelId,
        agentDir: params.agentDir,
      });
      return;
    }
    const error = params.terminal.error;
    const reason = resolveAuthProfileFailureReason({
      failoverReason: isFailoverError(error) ? error.reason : null,
      providerStarted:
        isFailoverError(error) && error.reason === "timeout"
          ? error.cliTimeout?.observedActivity
          : undefined,
    });
    if (reason) {
      await markAuthProfileFailure({
        store: params.store,
        profileId: params.profileId,
        reason,
        cfg: params.terminal.config,
        agentDir: params.agentDir,
        runId: params.terminal.runId,
        modelId: params.terminal.modelId,
      });
    }
  } catch (error) {
    log.warn(
      `CLI auth-profile ${params.terminal.outcome} settlement failed: ${formatErrorMessage(error)}`,
    );
  }
}

export function isClaudeCliBackend(provider: string): boolean {
  return provider.trim().toLowerCase() === "claude-cli";
}

export async function settleCliPreparationError(
  error: unknown,
  params: RunCliAgentParams,
): Promise<void> {
  try {
    params.assertCurrent?.();
    if (!(error instanceof CliAuthProfilePreparationError)) {
      return;
    }
    const store = await loadAuthProfileStoreForRuntimeAsync(error.agentDir, {
      externalCli: externalCliDiscoveryForProviderAuth({
        cfg: params.config,
        provider: error.provider,
        profileId: error.profileId,
      }),
    });
    await settleCliAuthProfile({
      store,
      profileId: error.profileId,
      provider: error.provider,
      agentDir: error.agentDir,
      terminal: {
        outcome: "failure",
        error,
        config: params.config,
        runId: params.runId,
        modelId: params.model,
      },
    });
  } finally {
    const reportCleanupError = (cleanupError: unknown) => {
      recordAgentCleanupFailure();
      log.warn(`bundle-mcp preparation cleanup failed: ${formatErrorMessage(cleanupError)}`);
    };
    try {
      await retireCliRunMcpRuntime(params, reportCleanupError);
    } catch (cleanupError) {
      reportCleanupError(cleanupError);
    }
  }
}

async function retireCliRunMcpRuntime(
  params: RunCliAgentParams,
  onError: (error: unknown) => void,
): Promise<void> {
  if (params.cleanupBundleMcpOnRunEnd !== true) {
    return;
  }
  // Preparation can open native-policy transports before an execution context exists.
  // The exact run session owns retirement even if its admission was revoked.
  const { retireSessionMcpRuntime } = await import("../agent-bundle-mcp-tools.js");
  await runCliCleanup(params, "cli-bundle-mcp-retire", async () => {
    await retireSessionMcpRuntime({
      sessionId: params.sessionId,
      reason: "cli-run-end",
      preserveActiveLeases: true,
      onError,
    });
  });
}

export async function settlePreparedCliRun(params: {
  context: PreparedCliRunContext;
  diagnosticLifecycle?: ClaudeCliRunDiagnosticLifecycle;
  run: (complete: (result: EmbeddedAgentRunResult) => void) => Promise<EmbeddedAgentRunResult>;
}): Promise<EmbeddedAgentRunResult> {
  const { context, diagnosticLifecycle, run } = params;
  const runParams = context.params;
  let completed: EmbeddedAgentRunResult | undefined;
  const warnAfterCommit = (error: unknown) =>
    log.warn(
      `CLI run ${runParams.runId} settlement failed after final reply commit: ${formatErrorMessage(error)}`,
    );
  let outcome: { result: EmbeddedAgentRunResult } | { error: unknown };
  try {
    outcome = {
      result: await run((result) => {
        completed = result;
      }),
    };
  } catch (error) {
    if (completed) {
      warnAfterCommit(error);
    }
    outcome = completed ? { result: completed } : { error };
  }
  let cleanupError: Error | undefined;
  const recordCleanupError = (error: unknown) => {
    recordAgentCleanupFailure();
    cleanupError ??= error instanceof Error ? error : new Error(formatErrorMessage(error));
  };
  try {
    await runCliCleanup(runParams, "cli-backend-release", async () => {
      await context.preparedBackend.cleanup?.();
    });
  } catch (error) {
    recordCleanupError(error);
  }
  if (runParams.cleanupCliLiveSessionOnRunEnd === true) {
    try {
      const { closeCliLiveSession } = await import("./cli-live-session-registry.js");
      await closeCliLiveSession(context, "restart");
    } catch (error) {
      recordCleanupError(error);
    }
  }
  try {
    await retireCliRunMcpRuntime(runParams, recordCleanupError);
  } catch (error) {
    recordCleanupError(error);
  }
  const delivered = "result" in outcome && hasCompletedSourceReplyDeliveryEvidence(outcome.result);
  if (cleanupError) {
    if (completed || "error" in outcome || delivered) {
      log.warn(`cli run cleanup failed after completion: ${formatErrorMessage(cleanupError)}`);
    } else {
      diagnosticLifecycle?.setPhase("cleanup");
    }
  }
  // Retiring a caller is not a provider failure and must not quarantine its credential.
  try {
    runParams.assertCurrent?.();
    // Settle only after backend recovery is exhausted. Recording inside an
    // attempt would quarantine a healthy profile for a recovered session fault.
    if (context.effectiveAuthProfileId && context.authProfileStore) {
      const profileId = context.effectiveAuthProfileId;
      const authProfileStore = context.authProfileStore;
      const terminal: Parameters<typeof settleCliAuthProfile>[0]["terminal"] | undefined =
        "error" in outcome
          ? {
              outcome: "failure",
              error: outcome.error,
              config: runParams.config,
              runId: runParams.runId,
              modelId: context.modelId,
            }
          : outcome.result.meta.executionTrace?.attempts?.at(-1)?.result === "success"
            ? { outcome: "success", modelId: context.modelId }
            : undefined;
      if (terminal) {
        await settleCliAuthProfile({
          store: authProfileStore,
          profileId,
          provider: authProfileStore.profiles[profileId]?.provider ?? runParams.provider,
          agentDir: context.agentDir,
          terminal,
        });
      }
    }
  } catch (error) {
    if (!completed) {
      throw error;
    }
    warnAfterCommit(error);
  }
  if ("error" in outcome) {
    throw outcome.error instanceof Error
      ? outcome.error
      : new Error(formatErrorMessage(outcome.error));
  }
  if (cleanupError && !completed && !delivered) {
    throw cleanupError;
  }
  return outcome.result;
}

function buildCliExecutionMetadata(
  context: PreparedCliRunContext,
  attempt: Pick<
    NonNullable<NonNullable<EmbeddedAgentRunResult["meta"]["executionTrace"]>["attempts"]>[number],
    "result" | "reason"
  >,
): Pick<EmbeddedAgentRunResult["meta"], "executionTrace" | "requestShaping"> {
  return {
    executionTrace: {
      winnerProvider: context.params.provider,
      winnerModel: context.modelId,
      attempts: [{ provider: context.params.provider, model: context.modelId, ...attempt }],
      fallbackUsed: false,
      runner: "cli",
    },
    requestShaping: {
      ...(context.params.thinkLevel ? { thinking: context.params.thinkLevel } : {}),
      ...(context.effectiveAuthProfileId ? { authMode: "auth-profile" } : {}),
    },
  };
}

export function buildBlockedCliRunResult(params: {
  message: string;
  context: PreparedCliRunContext;
  preparedContextAgentMeta: { contextTokens?: number };
  sessionBindingDisabled: boolean;
}): EmbeddedAgentRunResult {
  const { context, message, preparedContextAgentMeta, sessionBindingDisabled } = params;
  const runParams = context.params;
  return {
    payloads: [{ text: message, isError: true }],
    meta: {
      durationMs: Date.now() - context.started,
      finalAssistantVisibleText: message,
      finalAssistantRawText: message,
      livenessState: "blocked",
      terminalReply: sanitizeAgentRunTerminalReply(message),
      error: {
        kind: "hook_block",
        message,
      },
      systemPromptReport: context.systemPromptReport,
      ...buildCliExecutionMetadata(context, {
        result: "error",
        reason: "before_agent_run blocked the run",
      }),
      completion: {
        finishReason: "blocked",
        stopReason: "blocked",
        refusal: true,
      },
      agentMeta: {
        sessionId: runParams.sessionId ?? "",
        provider: runParams.modelProvider ?? runParams.provider,
        model: context.modelId,
        ...preparedContextAgentMeta,
        ...(sessionBindingDisabled ? { clearCliSessionBinding: true } : {}),
      },
    },
  };
}

export function buildCliDeliveredFailure(params: {
  error: unknown;
  evidence: NonNullable<
    ReturnType<typeof import("./delivery-evidence.js").getCliMessagingDeliveryEvidence>
  >;
  context: PreparedCliRunContext;
  preparedContextAgentMeta: { contextTokens?: number };
  sessionBindingDisabled: boolean;
  reusableCliSessionId?: string;
  bindingReplacedDuringRun?: boolean;
}): EmbeddedAgentRunResult {
  const {
    context,
    error,
    evidence,
    preparedContextAgentMeta,
    reusableCliSessionId,
    sessionBindingDisabled,
  } = params;
  const runParams = context.params;
  const message = formatErrorMessage(error);
  const { payloads } = resolveCliSourceReplyMirror({
    evidence,
    runParams,
    modelId: context.modelId,
  });
  const visiblePayloads =
    payloads.length > 0
      ? payloads
      : resolveExplicitFinalSourceReplyDeliveryEvidence(evidence) === false &&
          shouldDeliverMissingReplyNotice(runParams)
        ? [createMissingReplyNotice()]
        : undefined;
  const terminalReply = sanitizeAgentRunTerminalReply(
    resolveExplicitFinalSourceReplyDeliveryEvidence(evidence) === true &&
      hasCompletedSourceReplyDeliveryEvidence(evidence)
      ? payloads.map((payload) => payload.text ?? "").join("\n\n")
      : "",
  );
  return {
    ...(visiblePayloads ? { payloads: visiblePayloads } : {}),
    meta: {
      durationMs: Date.now() - context.started,
      systemPromptReport: context.systemPromptReport,
      terminalReply,
      stopReason: "error",
      error: { kind: "incomplete_turn", message, fallbackSafe: false },
      ...buildCliExecutionMetadata(context, { result: "error", reason: message }),
      completion: {
        finishReason: "error",
        stopReason: "error",
        refusal: false,
      },
      agentMeta: {
        sessionId: "",
        provider: runParams.modelProvider ?? runParams.provider,
        model: context.modelId,
        ...preparedContextAgentMeta,
        ...(sessionBindingDisabled ||
        shouldClearFailedCliSessionBinding({
          error,
          binding: reusableCliSessionId ? { sessionId: reusableCliSessionId } : undefined,
          bindingReplacedDuringRun: params.bindingReplacedDuringRun,
        })
          ? { clearCliSessionBinding: true }
          : {}),
      },
    },
    ...projectCliMessagingDeliveryEvidence(evidence),
    didSendViaMessagingTool: true,
  };
}

export function buildCliRunResult(params: {
  context: PreparedCliRunContext;
  output: CliOutput;
  preparedReply: PreparedCliRunTerminalReply;
  effectiveCliSessionId?: string;
  bindingFlushOk?: boolean;
  assistantTranscriptOwned?: boolean;
  assistantTranscriptIdempotencyKey?: string;
  usedHistoryPrompt: boolean;
  userTurnHandled: boolean;
  sessionBindingDisabled: boolean;
  preparedContextAgentMeta: { contextTokens?: number };
}): EmbeddedAgentRunResult {
  const {
    assistantTranscriptOwned,
    assistantTranscriptIdempotencyKey,
    bindingFlushOk,
    context,
    effectiveCliSessionId,
    output,
    preparedContextAgentMeta,
    preparedReply,
    sessionBindingDisabled,
    usedHistoryPrompt,
    userTurnHandled,
  } = params;
  const runParams = context.params;
  const rawText = output.rawText ?? output.text;
  const rawFinalText = output.rawFinalText;
  const { sourceReplyMirror } = preparedReply;
  const text = preparedReply.text;
  const finalAssistantVisibleText = text;
  const payloads =
    sourceReplyMirror.payloads.length > 0
      ? sourceReplyMirror.payloads
      : sourceReplyMirror.delivered
        ? undefined
        : text
          ? (output.textParts && text === output.text ? output.textParts : [text]).map(
              (partText, assistantMessageIndex) =>
                assistantTranscriptOwned || output.textParts
                  ? setReplyPayloadMetadata(
                      { text: partText },
                      {
                        ...(output.textParts ? { assistantMessageIndex } : {}),
                        ...(assistantTranscriptOwned ? { assistantTranscriptOwned: true } : {}),
                        ...(assistantTranscriptIdempotencyKey
                          ? { assistantTranscriptIdempotencyKey }
                          : {}),
                      },
                    )
                  : { text: partText },
            )
          : undefined;
  const payloadsWithToolMedia = mergeAttemptToolMediaPayloads({
    payloads,
    toolMediaUrls: output.toolMediaUrls,
    toolAudioAsVoice: output.toolAudioAsVoice,
    toolTrustedLocalMedia: output.toolTrustedLocalMedia,
    sourceReplyDeliveryMode: runParams.sourceReplyDeliveryMode,
  });
  const replyExpectation = resolveReplyExpectation(runParams);
  const payloadsForVisibleCompletion = filterAgentRunTerminalPayloadsForPresentation({
    payloads: payloadsWithToolMedia,
    isHeartbeatTrigger: runParams.trigger === "heartbeat" && !runParams.continuesConversation,
  });
  const unflushed = !sessionBindingDisabled && effectiveCliSessionId && bindingFlushOk === false;
  const terminalInterruption = output.terminalInterruption;
  // Cancellation preserves established continuity, but an unfinished replacement
  // still needs cleanup even when managed sessions skip the transcript probe.
  const cliSessionBindingCleared =
    sessionBindingDisabled ||
    unflushed ||
    shouldClearInterruptedCliSessionBinding({
      interrupted: terminalInterruption !== undefined,
      bindingReplacedDuringRun:
        effectiveCliSessionId !== resolveCliSessionId(context.reusableCliSession),
    });
  const persistedCliSessionId = cliSessionBindingCleared ? undefined : effectiveCliSessionId;
  const createdReseedReceipt =
    persistedCliSessionId &&
    usedHistoryPrompt &&
    isClaudeCliBackend(runParams.provider) &&
    output.finalPromptText !== undefined &&
    userTurnHandled &&
    runParams.sessionId
      ? {
          version: 1 as const,
          promptHash: hashCliReseedPrompt(output.finalPromptText),
          localSessionId: runParams.sessionId,
          userTurnDisposition: runParams.userTurnTranscriptRecorder?.hasPersisted()
            ? ("persisted" as const)
            : ("omitted" as const),
        }
      : undefined;
  const preservedReseedReceipt =
    runParams.cliSessionBinding && persistedCliSessionId === runParams.cliSessionBinding.sessionId
      ? runParams.cliSessionBinding.reseedReceipt
      : undefined;
  const reseedReceipt = createdReseedReceipt ?? preservedReseedReceipt;
  const agentSessionId =
    terminalInterruption || unflushed
      ? ""
      : sessionBindingDisabled
        ? (runParams.sessionId ?? "")
        : (effectiveCliSessionId ?? runParams.sessionId ?? "");
  const yielded = output.yielded === true;
  const presentationHiddenRequiredReply =
    !terminalInterruption &&
    !yielded &&
    !hasCompletionMessageSessionSpawn(output.acceptedSessionSpawns) &&
    !hasCompletedSourceReplyDeliveryEvidence(output) &&
    (payloadsWithToolMedia?.length ?? 0) > 0 &&
    (payloadsForVisibleCompletion?.length ?? 0) === 0 &&
    resolveReplyCompletion(replyExpectation, "empty").outcome === "missing";
  const stopReason = presentationHiddenRequiredReply
    ? "error"
    : (terminalInterruption?.reason ?? (yielded ? "end_turn" : "completed"));
  const resultPayloads = presentationHiddenRequiredReply
    ? shouldDeliverMissingReplyNotice(runParams)
      ? [createMissingReplyNotice()]
      : undefined
    : payloadsWithToolMedia;

  try {
    if (!terminalInterruption && runParams.onSuccessfulAuthBinding) {
      runParams.assertCurrent?.();
      runParams.onSuccessfulAuthBinding({
        ...(context.effectiveAuthProfileId
          ? { authProfileId: context.effectiveAuthProfileId }
          : {}),
        ...(context.authBindingFingerprint
          ? { authFingerprint: context.authBindingFingerprint }
          : {}),
        ...(!context.authBindingFingerprint && context.runtimeOwnerFingerprint
          ? {
              runtimeOwnerFingerprint: context.runtimeOwnerFingerprint,
              runtimeOwnerKind: "cli-runtime" as const,
              runtimeOwnerId: context.backendResolved.id,
            }
          : {}),
        ...(context.runtimeArtifactFingerprint
          ? {
              runtimeArtifactFingerprint: context.runtimeArtifactFingerprint,
              runtimeArtifactId: context.backendResolved.id,
            }
          : {}),
        ...(context.authBindingSkipsLocalCredential ? { skipLocalCredential: true } : {}),
      });
    }
  } catch (error) {
    if (!assistantTranscriptIdempotencyKey || terminalInterruption || yielded) {
      throw error;
    }
    log.warn(
      `CLI run ${runParams.runId} auth binding notification failed after final reply commit: ${formatErrorMessage(error)}`,
    );
  }

  return {
    payloads: resultPayloads,
    meta: {
      durationMs: Date.now() - context.started,
      ...(output.finalPromptText ? { finalPromptText: output.finalPromptText } : {}),
      ...(!presentationHiddenRequiredReply && finalAssistantVisibleText
        ? { finalAssistantVisibleText }
        : {}),
      ...(rawText ? { finalAssistantRawText: rawText } : {}),
      terminalReply: presentationHiddenRequiredReply
        ? { disposition: "empty" as const }
        : preparedReply.terminalReply,
      terminalReplyExpectation: replyExpectation,
      // An empty final message is recorded as "" so capture never falls back to
      // the cumulative raw text.
      ...(rawFinalText !== undefined && rawFinalText !== rawText
        ? { finalAssistantMessageRawText: rawFinalText }
        : {}),
      systemPromptReport: context.systemPromptReport,
      ...(presentationHiddenRequiredReply
        ? { stopReason }
        : terminalInterruption
          ? {
              aborted: true,
              providerStarted: true,
              stopReason,
              ...(terminalInterruption.reason === "timeout"
                ? { timeoutPhase: "provider" as const }
                : {}),
            }
          : yielded
            ? { yielded: true, livenessState: "paused" as const, stopReason }
            : {}),
      ...(output.yieldAcknowledgment ? { yieldAcknowledgment: output.yieldAcknowledgment } : {}),
      ...buildCliExecutionMetadata(context, {
        result: presentationHiddenRequiredReply
          ? "error"
          : (terminalInterruption?.reason ?? "success"),
        ...(presentationHiddenRequiredReply
          ? { reason: MISSING_REPLY_NOTICE_TEXT }
          : terminalInterruption
            ? { reason: formatCliTerminalInterruption(terminalInterruption) }
            : {}),
      }),
      completion: {
        finishReason: presentationHiddenRequiredReply
          ? "error"
          : (terminalInterruption?.reason ?? (yielded ? "end_turn" : "stop")),
        stopReason,
        refusal: false,
      },
      ...(presentationHiddenRequiredReply
        ? {
            error: {
              kind: "incomplete_turn" as const,
              message: MISSING_REPLY_NOTICE_TEXT,
              fallbackSafe: false,
            },
          }
        : {}),
      ...(output.toolSummary ? { toolSummary: output.toolSummary } : {}),
      agentMeta: {
        sessionId: agentSessionId,
        // Sessions persist the selected model provider; the CLI backend id stays in
        // the execution trace and keys native session bindings.
        provider: runParams.modelProvider ?? runParams.provider,
        model: context.modelId,
        ...preparedContextAgentMeta,
        usage: output.usage,
        ...(output.usage ? { lastCallUsage: output.usage } : {}),
        ...(output.diagnosticUsage ? { diagnosticUsage: output.diagnosticUsage } : {}),
        ...(persistedCliSessionId
          ? {
              cliSessionBinding: {
                sessionId: persistedCliSessionId,
                ...(context.effectiveAuthProfileId
                  ? { authProfileId: context.effectiveAuthProfileId }
                  : {}),
                ...(output.resumeCheckpointId
                  ? { resumeCheckpointId: output.resumeCheckpointId }
                  : {}),
                ...(context.authEpoch ? { authEpoch: context.authEpoch } : {}),
                authEpochVersion: context.authEpochVersion,
                ...(context.extraSystemPromptHash
                  ? { extraSystemPromptHash: context.extraSystemPromptHash }
                  : {}),
                ...(context.messageToolPolicyHash
                  ? { messageToolPolicyHash: context.messageToolPolicyHash }
                  : {}),
                ...(context.promptToolNamesHash
                  ? { promptToolNamesHash: context.promptToolNamesHash }
                  : {}),
                ...(context.cwdHash ? { cwdHash: context.cwdHash } : {}),
                ...(context.preparedBackend.mcpConfigHash
                  ? { mcpConfigHash: context.preparedBackend.mcpConfigHash }
                  : {}),
                ...(context.preparedBackend.mcpResumeHash
                  ? { mcpResumeHash: context.preparedBackend.mcpResumeHash }
                  : {}),
                ...(reseedReceipt ? { reseedReceipt } : {}),
              },
            }
          : {}),
        ...(cliSessionBindingCleared ? { clearCliSessionBinding: true } : {}),
      },
    },
    ...projectCliMessagingDeliveryEvidence(output),
    ...(output.acceptedSessionSpawns?.length
      ? { acceptedSessionSpawns: output.acceptedSessionSpawns }
      : {}),
  };
}
