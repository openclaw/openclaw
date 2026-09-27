import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
} from "../../auto-reply/reply-payload.js";
import {
  filterMessagingToolMediaDuplicates,
  filterMessagingToolReplyPayload,
  resolveMessagingToolPayloadDedupe,
} from "../../auto-reply/reply/reply-payloads-dedupe.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import {
  normalizeTextForComparison,
  resolveCurrentSourceMessagingToolPartial,
} from "../embedded-agent-helpers/messaging-dedupe.js";
import {
  captureAgentPluginRuntimeRefresh,
  createAgentPluginRuntimeRefresh,
  type PluginRuntimeRefreshSource,
} from "../plugin-runtime-refresh.js";
import {
  copyAttemptDeliveryState,
  type AttemptDeliveryState,
} from "./run/attempt-delivery-state.js";
import type { normalizeEmbeddedRunAttempt } from "./run/attempt-normalization.js";
import type { RunEmbeddedAgentParamsWithSessionFile } from "./run/internal-params.js";
import { createRunRetryBudget, type RunRetryBudget } from "./run/retry-budget.js";
import {
  normalizeEmbeddedRunAttemptResult,
  resolveSuccessfulToolNames,
} from "./run/run-attempt-result.js";
import { createPendingToolMediaCarry } from "./run/tool-media-payloads.js";
import type { EmbeddedTurnContinuationRequest } from "./run/turn-continuation.js";
import type { EmbeddedAgentRunResult } from "./types.js";
import { toNormalizedUsage } from "./usage-accumulator.js";

export type EmbeddedLogicalTurnContinuation = ReturnType<
  typeof createEmbeddedLogicalTurnContinuation
>;

// A reload from outside the run is not a change the model asked for, so it is not asked to verify one.
function continuationPrompt(source: PluginRuntimeRefreshSource | undefined): string {
  return source === "reload"
    ? "A plugin was reloaded while you were working. Continue the current task from the transcript; do not repeat completed actions or the original user request."
    : "The plugin runtime has been refreshed. Continue the current task from the transcript using the updated tools. Verify the requested change; do not repeat completed actions or the original user request.";
}

/** The embedded runner owns continuation data; tool controls never import its graph. */
export function createEmbeddedLogicalTurnContinuation(
  callbacks: RunEmbeddedAgentParamsWithSessionFile,
) {
  const refresh = createAgentPluginRuntimeRefresh();
  const pendingToolMedia = createPendingToolMediaCarry();
  const successfulToolNames = new Set<string>();
  let delivered: AttemptDeliveryState | undefined;
  let continuation: RunEmbeddedAgentParamsWithSessionFile | undefined;
  let deliveryCallbacks = callbacks;
  let retryBudget: RunRetryBudget | undefined;
  const closeGeneration = () => {
    continuation = undefined;
    refresh.close();
  };

  /** Called only after the attempt has persisted its completed tool results and released its tools. */
  function continueAfterAttempt(
    input: Parameters<typeof normalizeEmbeddedRunAttempt>[0],
    assertActive: () => void,
    isTurnTainted: () => boolean,
    request?: EmbeddedTurnContinuationRequest,
  ): EmbeddedAgentRunResult | undefined {
    if (
      input.dispatchedAttempt.rawAttempt.terminal.kind !== "ok" ||
      (!request && !captureAgentPluginRuntimeRefresh().isPending())
    ) {
      return undefined;
    }
    assertActive();
    const attempt = normalizeEmbeddedRunAttemptResult(input.dispatchedAttempt.rawAttempt);
    // Refresh ends before terminal preparation; keep settled successes with the logical run.
    for (const name of resolveSuccessfulToolNames(attempt)) {
      successfulToolNames.add(name);
    }
    delivered = copyAttemptDeliveryState(attempt);
    pendingToolMedia.capture(attempt);
    const { runInput, sessionPromptState: session, usageAccumulator: usage } = input;
    const params = runInput.runParams;
    const messages = attempt.continuationMessages ?? attempt.pluginRuntimeRefreshMessages;
    const previousMessages =
      params.continuationMessages ?? params.pluginRuntimeRefreshMessages ?? [];
    if (request?.policy) {
      deliveryCallbacks = { ...deliveryCallbacks, ...request.policy };
    }
    continuation = {
      ...params,
      ...request?.policy,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      sessionTarget: {
        ...params.sessionTarget,
        ...session.sessionTarget,
        ...session.sessionWriterFence,
      },
      initialTurnTainted: isTurnTainted(),
      preparedRunAdmission: undefined,
      pluginGeneration: undefined,
      turnContinuation: true,
      continuationMessages: messages ? [...previousMessages, ...messages] : previousMessages,
      contextEngineLogicalTurnLease: undefined,
      modelHasVision: undefined,
      modelThinkingCapability: undefined,
      modelFallbackAvailability: undefined,
      suppressNextUserMessagePersistence: true,
      prompt:
        request?.prompt ??
        "The plugin runtime has been refreshed. Continue the current task from the transcript using the updated tools. Verify the requested change; do not repeat completed actions or the original user request.",
    };
    return {
      meta: {
        durationMs: Date.now() - runInput.startedAtMs,
        terminalReply: { disposition: "empty" },
        agentMeta: {
          sessionId: session.sessionId,
          provider: input.provider,
          model: input.modelId,
          usage: toNormalizedUsage(usage),
          assistantTurns: usage.assistantTurns,
          ...(usage.bridgeCalls ? { bridgeCalls: usage.bridgeCalls } : {}),
        },
      },
    };
  }

  return {
    reviewSettledDraft: async (
      input: Parameters<typeof normalizeEmbeddedRunAttempt>[0],
      payloads: EmbeddedAgentRunResult["payloads"],
      signal: AbortSignal,
      assertActive: () => void,
      isTurnTainted: () => boolean,
    ): Promise<{
      continued?: EmbeddedAgentRunResult;
      terminalReplyDisposition?: "withhold";
    }> => {
      const params = input.runInput.runParams;
      if (!params.reviewSettledDraft) {
        return {};
      }
      const attempt = input.dispatchedAttempt.rawAttempt;
      const assertCurrent = () => {
        signal.throwIfAborted();
        assertActive();
      };
      assertCurrent();
      const disposition = await racePromiseWithAbortSignal(
        params.reviewSettledDraft({
          attempt,
          payloads: payloads ?? [],
          completedMessages: [
            ...(params.continuationMessages ?? params.pluginRuntimeRefreshMessages ?? []),
            ...(attempt.continuationMessages ?? attempt.pluginRuntimeRefreshMessages ?? []),
          ],
          signal,
        }),
        signal,
      ).catch((error: unknown) => {
        assertCurrent();
        throw error;
      });
      assertCurrent();
      if (disposition.action === "continue") {
        const continued = continueAfterAttempt(input, assertActive, isTurnTainted, disposition);
        if (!continued) {
          throw new Error("A settled draft continuation requires a successful attempt");
        }
        return { continued };
      }
      return {
        terminalReplyDisposition: disposition.action === "withhold" ? "withhold" : undefined,
      };
    },
    retryBudget: (maxAttempts: number) => (retryBudget ??= createRunRetryBudget(maxAttempts)),
    run: <T>(run: () => T): T => {
      closeGeneration();
      return refresh.run(run);
    },
    continueAfterAttempt,
    mergeToolMedia: pendingToolMedia.merge,
    applyDeliveryState: <T extends Parameters<typeof copyAttemptDeliveryState>[0]>(
      attempt: T,
    ): T =>
      delivered
        ? Object.assign(
            attempt,
            copyAttemptDeliveryState(normalizeEmbeddedRunAttemptResult(attempt), delivered),
          )
        : attempt,
    withDeliveryCallbacks: (params: RunEmbeddedAgentParamsWithSessionFile) =>
      delivered
        ? { ...params, ...createInheritedDeliveryCallbacks(params, deliveryCallbacks, delivered) }
        : params,
    mergeTerminalReceipt: (result: EmbeddedAgentRunResult) => {
      const receipt = result.meta.agentMeta?.terminalReceipt;
      if (receipt && successfulToolNames.size > 0) {
        receipt.successfulToolNames = [
          ...new Set([...successfulToolNames, ...receipt.successfulToolNames]),
        ];
      }
    },
    takeContinuation: () => {
      const next = continuation;
      closeGeneration();
      return next;
    },
    close: () => {
      closeGeneration();
      delivered = undefined;
      pendingToolMedia.clear();
      successfulToolNames.clear();
    },
  };
}
