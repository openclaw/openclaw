import { preserveCompactionReplayWindow } from "@openclaw/ai/transports";
import { filterHeartbeatTranscriptArtifacts } from "../../../auto-reply/heartbeat-filter.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { patchSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { readSessionEntrySummariesInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import {
  selectBoundedModelRequests,
  type ModelContextRequest,
} from "../../../config/sessions/session-model-context-window.js";
import {
  sessionEntryCommitGuardOptions,
  type SessionSourceAssertion,
} from "../../../config/sessions/session-source-authority.js";
import { isOwnedTranscriptPayload } from "../../../config/sessions/transcript-json.js";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../../context-engine/host-compat.js";
import { freezeJsonSnapshot } from "../../../shared/immutable-data.js";
import { shouldMergeConsecutiveTurns } from "../../embedded-agent-helpers/turns.js";
import { prepareHarnessContextEnginePrompt } from "../../harness/context-engine-lifecycle.js";
import { getHistoryLimitFromSessionKey, limitHistoryTurns } from "../history.js";
import { log } from "../logger.js";
import { sanitizeSessionHistory, validateReplayTurns } from "../replay-history.js";
import { readEmbeddedContinuationPrefix } from "./attempt-continuation.js";
import type { EmbeddedAttemptExecutionPhaseInput } from "./attempt-execution-types.js";
import { loadAttemptSessionEntryAfterQuotaMaintenance } from "./attempt-transcript-helpers.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";
import { resolveEmbeddedSessionContextLimits } from "./session-context-limits.js";

type PreparedEmbeddedAttemptHistory = {
  contextEnginePromptAuthority: NonNullable<AssembleResult["promptAuthority"]>;
  contextEngineAssemblySucceeded: boolean;
  retainedCurrentTurnMessageCount?: number;
  unwindowedContextEngineMessagesForPrecheck?: AgentMessage[];
};

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
  const continuation = await readEmbeddedContinuationPrefix(attempt);
  let systemPromptText = input.prepared.sessionRuntime.state.systemPromptText;
  const setSystemPrompt = (nextSystemPrompt: string) => {
    systemPromptText = nextSystemPrompt;
    setActiveSessionSystemPrompt(nextSystemPrompt);
  };

  if (isRawModelRun) {
    activeSession.agent.reset();
    setSystemPrompt("");
    cacheTrace?.recordStage("session:raw-model-run", {
      messages: continuation?.prefix ?? activeSession.messages,
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
      messages: continuation?.prefix ?? activeSession.messages,
      allowedToolNames: replayAllowedToolNames,
      sessionManager,
    });
    input.setup.prepStages.mark("history-sanitize");
    cacheTrace?.recordStage("session:sanitized", { messages: prior });
    // Keep each keyed user row intact until prompt() has resolved the current turn.
    // The stream boundary merges projected rows for providers requiring alternation.
    const validated = await validateReplayTurns({
      ...replayContext(),
      messages: prior,
      preserveUserTurns: true,
    });
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
          // A fork runs under its own key but keeps its source conversation's history window.
          getHistoryLimitFromSessionKey(
            attempt.sandboxSessionKey ?? attempt.sessionKey,
            attempt.config,
            {
              accountId: attempt.agentAccountId,
              peerId: attempt.conversationRoutePeerId,
              chatType: attempt.chatType,
            },
          ),
          {
            groupConsecutiveUserTurns:
              transcriptPolicy.validateAnthropicTurns &&
              shouldMergeConsecutiveTurns(transcriptPolicy, attempt.model.api),
          },
        ),
        attempt.model,
        {
          sessionId: attempt.sessionId,
          enabled: compactionReplayEnabled,
        },
      );
    }
    input.setup.prepStages.mark("history-window");
    cacheTrace?.recordStage("session:limited", { messages: limited });
    if (continuation || limited.length > 0 || prior.length > 0) {
      activeSession.agent.state.messages = limited;
    }
  }

  let contextEnginePromptAuthority: NonNullable<AssembleResult["promptAuthority"]> = "assembled";
  let contextEngineAssemblySucceeded = false;
  let unwindowedContextEngineMessagesForPrecheck: AgentMessage[] | undefined;
  if (activeContextEngine) {
    try {
      // Assemble may window the input in place. Preserve the original history for
      // the overflow precheck when the engine says preassembly can still overflow.
      const preassemblyMessages = [
        ...activeSession.messages,
        ...(continuation?.currentTurnMessages ?? []),
      ];
      const reserveTokens = Math.max(0, Math.floor(settingsManager.getCompactionReserveTokens()));
      const contextTokenBudget = Math.max(
        1,
        Math.floor(
          attempt.contextTokenBudget ??
            attempt.model.contextWindow ??
            attempt.model.maxTokens ??
            DEFAULT_CONTEXT_TOKENS,
        ),
      );
      const promptBudget = Math.max(1, contextTokenBudget - reserveTokens);
      const prompt = orphanRepair?.contextEnginePrompt ?? attempt.prompt ?? "";
      const renderedPromptTokens = estimateRenderedLlmBoundaryTokenPressure({
        systemPrompt: systemPromptText,
        prompt,
      });
      const messageBudget = Math.max(1, promptBudget - renderedPromptTokens);
      const transcriptReadFence = attempt.userTurnTranscriptRecorder?.getAdmissionReceipt();
      const assembled = await assembleHarnessContextEngine({
        contextEngine: activeContextEngine,
        sessionId: attempt.sessionId,
        sessionKey: attempt.sessionKey,
        agentId: sessionAgentId,
        appendOnlyRuntimeContext: transcriptPolicy.appendOnlyRuntimeContext,
        messages: activeSession.messages,
        currentTurnMessages: continuation?.currentTurnMessages,
        tokenBudget: messageBudget,
        availableTools: new Set(capabilityToolNames),
        citationsMode: attempt.config?.memory?.citations,
        sandboxed,
        modelId: attempt.modelId,
        maxOutputTokens: reserveTokens,
        contextEngineHostSupport: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
        providerId: attempt.provider,
        requestedModelId: attempt.requestedModelId,
        fallbackReason: attempt.fallbackReason,
        degradedReason: attempt.degradedReason,
        transcriptReadFence,
        ...(attempt.prompt !== undefined ? { prompt } : {}),
      });
      if (!assembled) {
        throw new Error("context engine assemble returned no result");
      }
      const assembledMessages = transcriptPolicy.repairToolUseResultPairing
        ? sanitizeToolUseResultPairingForModel(assembled.messages, isOpenAIResponsesApi)
        : assembled.messages;
      if (assembledMessages !== activeSession.messages) {
        activeSession.agent.state.messages = assembledMessages;
      }
      contextEnginePromptAuthority = assembled.promptAuthority ?? "assembled";
      contextEngineAssemblySucceeded = true;
      if (contextEnginePromptAuthority === "preassembly_may_overflow") {
        unwindowedContextEngineMessagesForPrecheck = preassemblyMessages;
      }
      if (assembled.systemPromptAddition) {
        setSystemPrompt(
          prependSystemPromptAdditionAfterCacheBoundary({
            systemPrompt: systemPromptText,
            systemPromptAddition: assembled.systemPromptAddition,
          }),
        );
        log.debug(
          `context engine: prepended system prompt addition (${assembled.systemPromptAddition.length} chars)`,
        );
      }
    } catch (error) {
      if (continuation) {
        throw error;
      }
      log.warn(`context engine assemble failed, using pipeline messages: ${String(error)}`);
    }
  }

  if (!activeContextEngine && continuation) {
    activeSession.agent.state.messages = [
      ...activeSession.messages,
      ...continuation.currentTurnMessages,
    ];
  }

  return {
    contextEnginePromptAuthority,
    contextEngineAssemblySucceeded,
    retainedCurrentTurnMessageCount: continuation?.currentTurnMessages.length ?? 0,
    ...(unwindowedContextEngineMessagesForPrecheck
      ? { unwindowedContextEngineMessagesForPrecheck }
      : {}),
  };
}
