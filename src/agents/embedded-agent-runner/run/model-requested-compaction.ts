import { getRuntimeConfigSnapshot } from "../../../config/config.js";
import { runContextEngineMaintenance } from "../context-engine-maintenance.js";
import { log } from "../logger.js";
import {
  compactEmbeddedRunForRecovery,
  type EmbeddedRunCompactionRecoveryInput,
} from "./compaction-runtime.js";
import { createRunRecoveryDiagId } from "./helpers.js";

/** The attempt has settled and released its tools; the existing run still owns the transcript. */
export async function compactModelRequestedBoundary(input: EmbeddedRunCompactionRecoveryInput) {
  const request = input.attempt.preflightRecovery?.requestedCompaction;
  input.assertRecoveryActive();
  if (
    !request ||
    !input.genericCompactionRecoveryAllowed ||
    input.contextTokenBudget === undefined ||
    input.runParams.config?.agents?.defaults?.compaction?.enabled === false ||
    getRuntimeConfigSnapshot()?.agents?.defaults?.compaction?.enabled === false
  ) {
    return;
  }
  const compaction = await compactEmbeddedRunForRecovery(input, {
    tokenBudget: input.contextTokenBudget,
    trigger: "budget",
    requestedCompaction: request,
    diagId: createRunRecoveryDiagId(),
    attempt: 1,
    maxAttempts: 1,
    currentTokenCount: input.attempt.preflightRecovery?.estimatedPromptTokens,
  });
  input.assertRecoveryActive();
  const { result, previousSessionId } = compaction;
  if (result.compacted) {
    if (input.contextEngine.maintain) {
      const active = input.getActiveSession();
      const transcript = await input.prepareRecoverySession(input.contextTokenBudget);
      await runContextEngineMaintenance({
        ...transcript,
        contextEngine: input.contextEngine,
        sessionId: active.id,
        sessionKey: input.resolvedSessionKey,
        sessionTarget: active.target,
        sessionFile: active.file,
        reason: "compaction",
        runtimeContext: compaction.runtimeContext,
        runtimeSettings: compaction.runtimeSettings,
        config: input.runParams.config,
        agentId: input.sessionAgentId,
        contextEngineAgentId: input.contextEngineAgentId,
        abortSignal: input.runParams.abortSignal,
      });
      input.assertRecoveryActive();
    }
    input.runParams.onAutoCompactionSucceeded?.(input.state.autoCompactionCount);
    input.assertRecoveryActive();
    input.armPostCompactionGuard();
  } else {
    // Voluntary compaction is not overflow: keep the original history and continue
    // once, rather than truncating tools, switching models, or replaying actions.
    log.warn("Model-requested compaction did not replace context; continuing recorded work", {
      reason: result.reason,
    });
  }
  await input.runOwnsCompactionAfterHook("model-requested compaction", result, previousSessionId);
  input.assertRecoveryActive();
}
