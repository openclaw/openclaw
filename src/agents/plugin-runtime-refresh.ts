import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { normalizeEmbeddedRunAttempt } from "./embedded-agent-runner/run/attempt-normalization.js";
import type { RunEmbeddedAgentParamsWithSessionFile } from "./embedded-agent-runner/run/internal-params.js";
import { resolveSuccessfulToolNames } from "./embedded-agent-runner/run/run-attempt-result.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import { toNormalizedUsage } from "./embedded-agent-runner/usage-accumulator.js";

type Refresh = {
  active: boolean;
  holds: number;
  consumer?: () => boolean;
  requested: boolean;
  successfulToolNames: Set<string>;
  continuation?: RunEmbeddedAgentParamsWithSessionFile;
};

const refreshScope = resolveGlobalSingleton(
  Symbol.for("openclaw.agentPluginRuntimeRefresh"),
  () => new AsyncLocalStorage<Refresh>(),
);

/** Captured host control survives plugin callbacks without becoming run authority. */
export function captureAgentPluginRuntimeRefresh() {
  const owner = refreshScope.getStore();
  return {
    bindConsumer: (isCurrent: () => boolean) => {
      if (owner?.active) {
        owner.consumer = isCurrent;
      }
    },
    request: (): boolean => {
      if (!owner?.active || owner.consumer?.() !== true) {
        return false;
      }
      owner.requested = true;
      return true;
    },
    isRequested: () => owner?.active === true && owner.requested,
    isPending: () => owner?.active === true && owner.requested && owner.holds === 0,
    hold: () => {
      if (!owner?.active) {
        return () => {};
      }
      owner.holds += 1;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          owner.holds -= 1;
        }
      };
    },
    assertActive: () => {
      if (owner && !owner.active) {
        throw new Error("Plugin runtime changed. Continue with the refreshed tool catalog.");
      }
    },
    assertCurrent: () => {
      if (owner && (!owner.active || owner.requested)) {
        throw new Error(
          "Plugin runtime changed. Continue with the refreshed tool catalog; do not repeat completed actions.",
        );
      }
    },
  };
}

/** Called only after the attempt has persisted its completed tool results and released its tools. */
export function continueAgentAfterPluginRuntimeRefresh(
  input: Parameters<typeof normalizeEmbeddedRunAttempt>[0],
  assertActive: () => void,
  isTurnTainted: () => boolean,
): EmbeddedAgentRunResult | undefined {
  const owner = refreshScope.getStore();
  if (
    input.dispatchedAttempt.rawAttempt.terminal.kind !== "ok" ||
    !owner?.active ||
    !owner.requested ||
    owner.holds > 0
  ) {
    return undefined;
  }
  assertActive();
  // Refresh ends before terminal preparation; keep settled successes with the logical run.
  for (const name of resolveSuccessfulToolNames(input.dispatchedAttempt.rawAttempt)) {
    owner.successfulToolNames.add(name);
  }
  const { runInput, sessionPromptState: session, usageAccumulator: usage } = input;
  const params = runInput.runParams;
  owner.continuation = {
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

/** One visible run owns refresh requests across all of its prepared runtime generations. */
export function createAgentPluginRuntimeRefresh() {
  let owner: Refresh | undefined;
  const successfulToolNames = new Set<string>();
  const close = () => {
    if (owner) {
      owner.active = false;
      owner.consumer = undefined;
      owner.requested = false;
      owner.continuation = undefined;
    }
  };
  return {
    run: <T>(run: () => T): T => {
      close();
      owner = { active: true, holds: 0, requested: false, successfulToolNames };
      return refreshScope.run(owner, run);
    },
    mergeTerminalReceipt: (result: EmbeddedAgentRunResult) => {
      const receipt = result.meta.agentMeta?.terminalReceipt;
      if (receipt && successfulToolNames.size > 0) {
        receipt.successfulToolNames = [
          ...new Set([...successfulToolNames, ...receipt.successfulToolNames]),
        ];
      }
    },
    takeContinuation: () => {
      const continuation = owner?.continuation;
      close();
      return continuation;
    },
    close,
  };
}
