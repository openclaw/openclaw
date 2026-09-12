import {
  captureAgentPluginRuntimeRefresh,
  createAgentPluginRuntimeRefresh,
} from "../plugin-runtime-refresh.js";
import type { normalizeEmbeddedRunAttempt } from "./run/attempt-normalization.js";
import type { RunEmbeddedAgentParamsWithSessionFile } from "./run/internal-params.js";
import { resolveSuccessfulToolNames } from "./run/run-attempt-result.js";
import type { EmbeddedAgentRunResult } from "./types.js";
import { toNormalizedUsage } from "./usage-accumulator.js";

export type EmbeddedPluginRuntimeRefresh = ReturnType<
  typeof createEmbeddedAgentPluginRuntimeRefresh
>;

/** The embedded runner owns continuation data; tool controls never import its graph. */
export function createEmbeddedAgentPluginRuntimeRefresh() {
  const refresh = createAgentPluginRuntimeRefresh();
  const successfulToolNames = new Set<string>();
  let continuation: RunEmbeddedAgentParamsWithSessionFile | undefined;
  const close = () => {
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
    // Refresh ends before terminal preparation; keep settled successes with the logical run.
    for (const name of resolveSuccessfulToolNames(input.dispatchedAttempt.rawAttempt)) {
      successfulToolNames.add(name);
    }
    const { runInput, sessionPromptState: session, usageAccumulator: usage } = input;
    const params = runInput.runParams;
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
      close();
      return refresh.run(run);
    },
    continueAfterAttempt,
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
      close();
      return next;
    },
    close,
  };
}
