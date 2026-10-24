import { preserveCompactionReplayWindow } from "@openclaw/ai/transports";
import { filterHeartbeatTranscriptArtifacts } from "../../../auto-reply/heartbeat-filter.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { patchSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { readSessionEntrySummariesInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import {
  sessionEntryCommitGuardOptions,
  type SessionSourceAssertion,
} from "../../../config/sessions/session-source-authority.js";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../../context-engine/host-compat.js";
import { prepareHarnessContextEnginePrompt } from "../../harness/context-engine-lifecycle.js";
import { getHistoryLimitFromSessionKey, limitHistoryTurns } from "../history.js";
import { log } from "../logger.js";
import { sanitizeSessionHistory, validateReplayTurns } from "../replay-history.js";
import { bindToolResultPromptProjectionKeys } from "../tool-result-projection-key.js";
import type { EmbeddedAttemptExecutionPhaseInput } from "./attempt-execution-types.js";
import { loadAttemptSessionEntryAfterQuotaMaintenance } from "./attempt-transcript-helpers.js";

export async function prepareEmbeddedAttemptHistory(
  input: EmbeddedAttemptExecutionPhaseInput,
  assertActive: SessionSourceAssertion,
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
      messages: bindToolResultPromptProjectionKeys(
        activeSession.messages,
        input.prepared.sessionRuntime.toolResultPromptProjectionState,
      ),
      allowedToolNames: replayAllowedToolNames,
      sessionManager,
    });
    input.setup.prepStages.mark("history-sanitize");
    cacheTrace?.recordStage("session:sanitized", { messages: prior });
    const validated = await validateReplayTurns({ ...replayContext(), messages: prior });
    input.setup.prepStages.mark("history-validation");

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
        const subagents = entries.flatMap(({ entry }) =>
          entry.spawnedBy === sessionEntry.sessionId
            ? [{ sessionId: entry.sessionId, role: entry.subagentRole, lastStatus: entry.status }]
            : [],
        );
        const hasSubagents = subagents.length > 0;
        // The user role makes the fallback treat the briefing as input, not its own output.
        validated.push({
          role: "user",
          content: [
            "[SYSTEM HANDOFF] The previous model is no longer active and a fallback model is now active.",
            ...(hasSubagents
              ? [
                  "You are the new LEADER (Orchestrator). Do not perform tasks already delegated to subordinates.",
                  "",
                  "ACTIVE SUBORDINATE UNITS:",
                  subagents
                    .map(
                      (s) =>
                        `- Subagent ${s.sessionId} (${s.role ?? "leaf"}): ${s.lastStatus ?? "running"}`,
                    )
                    .join("\n"),
                ]
              : [
                  "Review the current state below and continue the conversation from where the previous model left off.",
                ]),
            "",
            "CURRENT STATE SUMMARY:",
            suspension.summary ?? "No recovery briefing was captured.",
            ...(hasSubagents
              ? [
                  "",
                  "INSTRUCTIONS:",
                  "1. Review the state and subordinate reports.",
                  "2. Provide strategic guidance and commands to subordinates.",
                  "3. Do not repeat work already performed by subordinates.",
                ]
              : []),
          ].join("\n"),
          timestamp: Date.now(),
        });
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
          {
            skipMaintenance: true,
            takeCacheOwnership: true,
            ...sessionEntryCommitGuardOptions(assertActive),
          },
        );
        assertActive();
      }
    }

    let limited = validated;
    if (!isSettledTurnFinalization) {
      const heartbeatFiltered = filterHeartbeatTranscriptArtifacts(validated);
      limited = preserveCompactionReplayWindow(
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
    }
    input.setup.prepStages.mark("history-window");
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
    memoryProjectKey: attempt.preparedModelRuntime?.projectKey ?? undefined,
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
  input.setup.prepStages.mark("context-engine");
  activeSession.agent.state.messages = messages;
  if (systemPrompt !== systemPromptText) {
    setSystemPrompt(systemPrompt);
  }
  return prepared;
}
