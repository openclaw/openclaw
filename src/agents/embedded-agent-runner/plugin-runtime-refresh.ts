import {
  captureAgentPluginRuntimeRefresh,
  createAgentPluginRuntimeRefresh,
} from "../plugin-runtime-refresh.js";
import { createInheritedDeliveryCallbacks } from "./plugin-runtime-refresh-delivery.js";
import {
  copyAttemptDeliveryState,
  type AttemptDeliveryState,
} from "./run/attempt-delivery-state.js";
import type { normalizeEmbeddedRunAttempt } from "./run/attempt-normalization.js";
import type { RunEmbeddedAgentParamsWithSessionFile } from "./run/internal-params.js";
import {
  normalizeEmbeddedRunAttemptResult,
  resolveSuccessfulToolNames,
} from "./run/run-attempt-result.js";
import { createPendingToolMediaCarry } from "./run/tool-media-payloads.js";
import type { EmbeddedAgentRunResult } from "./types.js";
import { toNormalizedUsage } from "./usage-accumulator.js";

export type EmbeddedPluginRuntimeRefresh = ReturnType<
  typeof createEmbeddedAgentPluginRuntimeRefresh
>;

/** The embedded runner owns continuation data; tool controls never import its graph. */
export function createEmbeddedAgentPluginRuntimeRefresh(
  callbacks: RunEmbeddedAgentParamsWithSessionFile,
) {
  const refresh = createAgentPluginRuntimeRefresh();
  const pendingToolMedia = createPendingToolMediaCarry();
  const successfulToolNames = new Set<string>();
  let delivered: AttemptDeliveryState | undefined;
  let continuation: RunEmbeddedAgentParamsWithSessionFile | undefined;
  const closeGeneration = () => {
    continuation = undefined;
    refresh.close();
  };

  /** Called only after the attempt has persisted its completed tool results and released its tools. */
  function continueAfterAttempt(
    input: Parameters<typeof normalizeEmbeddedRunAttempt>[0],
    assertActive: () => void,
    isTurnTainted: () => boolean,
  ): EmbeddedAgentRunResult | undefined {
    if (
      input.dispatchedAttempt.rawAttempt.terminal.kind !== "ok" ||
      !captureAgentPluginRuntimeRefresh().isPending()
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
    const messages = attempt.pluginRuntimeRefreshMessages;
    continuation = {
      ...params,
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
      pluginRuntimeRefreshContinuation: true,
      pluginRuntimeRefreshMessages: messages
        ? [...(params.pluginRuntimeRefreshMessages ?? []), ...messages]
        : params.pluginRuntimeRefreshMessages,
      contextEngineLogicalTurnLease: undefined,
      modelHasVision: undefined,
      modelThinkingCapability: undefined,
      modelFallbackAvailability: undefined,
      suppressNextUserMessagePersistence: true,
      prompt:
        "The plugin runtime has been refreshed. Continue the current task from the transcript using the updated tools. Verify the requested change; do not repeat completed actions or the original user request.",
    };
    return {
      meta: {
        durationMs: Date.now() - runInput.startedAtMs,
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
        ? { ...params, ...createInheritedDeliveryCallbacks(params, callbacks, delivered) }
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
