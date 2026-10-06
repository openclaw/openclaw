import { preserveCompactionReplayWindow } from "@openclaw/ai/transports";
import { buildHierarchyReinforcementMessage } from "../../../auto-reply/handoff-summarizer.js";
import { filterHeartbeatTranscriptArtifacts } from "../../../auto-reply/heartbeat-filter.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { patchSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { readSessionEntrySummariesInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../../context-engine/host-compat.js";
import { resolveHeartbeatSummaryForAgent } from "../../../infra/heartbeat-summary.js";
import { prepareHarnessContextEnginePrompt } from "../../harness/context-engine-lifecycle.js";
import { sanitizeToolUseResultPairingForModel } from "../../session-transcript-repair.js";
import { getHistoryLimitFromSessionKey, limitHistoryTurns } from "../history.js";
import { log } from "../logger.js";
import { sanitizeSessionHistory, validateReplayTurns } from "../replay-history.js";
import type { EmbeddedAttemptExecutionPhaseInput } from "./attempt-execution-types.js";
import { loadAttemptSessionEntryAfterQuotaMaintenance } from "./attempt-transcript-helpers.js";

export async function prepareEmbeddedAttemptHistory(
  input: EmbeddedAttemptExecutionPhaseInput,
  assertActive: () => void,
) {
  const { attempt, activeContextEngine, isRawModelRun } = input;
  const {
    agentSession: { activeSession, settingsManager, setActiveSessionSystemPrompt },
    boundary: { orphanRepair },
    cacheTrace,
    isOpenAIResponsesApi,
    sessionManager,
    transcriptPolicy,
    transport: { compactionReplayEnabled },
  } = input.prepared.sessionRuntime;
  const { capabilityToolNames, replayAllowedToolNames } =
    input.prepared.toolCatalog.toolSearchRunPlan;
  const { effectiveWorkspace, sessionAgentId } = input.setup;
  const sandboxed = input.setup.sandbox?.enabled === true;
  const isSettledTurnFinalization = attempt.operation === "settled-tool-finalization";
  let systemPromptText = input.prepared.sessionRuntime.state.systemPromptText;
  const setSystemPrompt = (nextSystemPrompt: string) => {
    systemPromptText = nextSystemPrompt;
    setActiveSessionSystemPrompt(nextSystemPrompt);
  };

  if (isRawModelRun) {
    activeSession.agent.reset();
    setSystemPrompt("");
    cacheTrace?.recordStage("session:raw-model-run", {
      messages: activeSession.messages,
      system: systemPromptText,
    });
  } else {
    const replayContext = () => ({
      modelApi: attempt.model.api,
      modelId: attempt.modelId,
      provider: attempt.provider,
      config: attempt.config,
      workspaceDir: effectiveWorkspace,
      env: process.env,
      model: attempt.model,
      sessionId: attempt.sessionId,
      policy: transcriptPolicy,
    });
    const prior = await sanitizeSessionHistory({
      ...replayContext(),
      messages: activeSession.messages,
      allowedToolNames: replayAllowedToolNames,
      sessionManager,
    });
    cacheTrace?.recordStage("session:sanitized", { messages: prior });
    const validated = await validateReplayTurns({ ...replayContext(), messages: prior });

    if (
      attempt.sessionKey &&
      attempt.sessionPersistence !== "detached" &&
      !isSettledTurnFinalization
    ) {
      const storePath = resolveSessionStorePathCore(attempt.config?.session?.store, {
        agentId: sessionAgentId,
      });
      const sessionEntry = await loadAttemptSessionEntryAfterQuotaMaintenance(
        { agentId: sessionAgentId, storePath, sessionKey: attempt.sessionKey },
        assertActive,
      );
      assertActive();
      const suspension = sessionEntry?.quotaSuspension;
      if (sessionEntry && suspension?.state === "resuming") {
        const entries = await readSessionEntrySummariesInWorker({
          agentId: sessionAgentId,
          storePath,
        });
        assertActive();
        const subagents = entries
          .map(({ entry }) => entry)
          .filter((entry) => entry.spawnedBy === sessionEntry.sessionId)
          .map((entry) => ({
            sessionId: entry.sessionId,
            role: entry.subagentRole,
            lastStatus: entry.status,
          }));
        validated.push(
          buildHierarchyReinforcementMessage({
            summary: suspension.summary ?? "No recovery briefing was captured.",
            activeSubagents: subagents,
          }),
        );
        await patchSessionEntryCore(
          { agentId: sessionAgentId, storePath, sessionKey: attempt.sessionKey },
          (entry) => {
            if (
              entry.sessionId !== sessionEntry.sessionId ||
              entry.quotaSuspension?.state !== "resuming"
            ) {
              return null;
            }
            return {
              quotaSuspension: { ...entry.quotaSuspension, state: "active" },
            };
          },
          { skipMaintenance: true, takeCacheOwnership: true, assertCommitAllowed: assertActive },
        );
        assertActive();
      }
    }

    const limited = (() => {
      if (isSettledTurnFinalization) {
        return validated;
      }
      const heartbeatSummary =
        attempt.config && sessionAgentId
          ? resolveHeartbeatSummaryForAgent(attempt.config, sessionAgentId)
          : undefined;
      const heartbeatFiltered = filterHeartbeatTranscriptArtifacts(
        validated,
        heartbeatSummary?.ackMaxChars,
        heartbeatSummary?.prompt,
      );
      const truncated = preserveCompactionReplayWindow(
        heartbeatFiltered,
        limitHistoryTurns(
          heartbeatFiltered,
          getHistoryLimitFromSessionKey(attempt.sessionKey, attempt.config, {
            accountId: attempt.agentAccountId,
            peerId: attempt.conversationRoutePeerId,
            chatType: attempt.chatType,
          }),
        ),
        attempt.model,
        {
          sessionId: attempt.sessionId,
          authProfileId: attempt.runtimePlan?.auth.forwardedAuthProfileId,
          enabled: compactionReplayEnabled,
        },
      );
      // Truncation can orphan tool_result blocks by removing the assistant message
      // that contained the matching tool_use, so repair the pairs once more.
      return transcriptPolicy.repairToolUseResultPairing
        ? sanitizeToolUseResultPairingForModel(truncated, isOpenAIResponsesApi)
        : truncated;
    })();
    cacheTrace?.recordStage("session:limited", { messages: limited });
    if (limited.length > 0 || prior.length > 0) {
      activeSession.agent.state.messages = limited;
    }
  }

  const prompt = orphanRepair?.contextEnginePrompt ?? attempt.prompt ?? "";
  const { messages, systemPrompt, ...prepared } = await prepareHarnessContextEnginePrompt({
    ...attempt,
    contextEngine: activeContextEngine,
    agentId: sessionAgentId,
    appendOnlyRuntimeContext: transcriptPolicy.appendOnlyRuntimeContext,
    messages: activeSession.messages,
    availableTools: new Set(capabilityToolNames),
    citationsMode: attempt.config?.memory?.citations,
    sandboxed,
    promptBudget: {
      contextTokens:
        attempt.contextTokenBudget ?? attempt.model.contextWindow ?? attempt.model.maxTokens,
      reserveTokens: settingsManager.getCompactionReserveTokens(),
      systemPrompt: systemPromptText,
      prompt,
    },
    contextEngineHostSupport: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
    providerId: attempt.provider,
    transcriptReadFence: attempt.userTurnTranscriptRecorder?.getAdmissionReceipt(),
    ...(attempt.prompt !== undefined ? { prompt } : {}),
    repairToolUseResultPairing: transcriptPolicy.repairToolUseResultPairing,
    isOpenAIResponsesApi,
    warn: (message) => log.warn(message),
  });
  activeSession.agent.state.messages = messages;
  if (systemPrompt !== systemPromptText) {
    setSystemPrompt(systemPrompt);
  }
  return prepared;
}
