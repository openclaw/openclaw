import { preserveCompactionReplayWindow } from "@openclaw/ai/transports";
import { filterHeartbeatTranscriptArtifacts } from "../../../auto-reply/heartbeat-filter.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { patchSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { isExplicitChatFork } from "../../../config/sessions/session-entry-lineage.js";
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
import { isLocalBaseUrl } from "../../model-catalog-route.js";
import { sessionManagerInheritedMessages } from "../../sessions/session-manager-current-turn.js";
import { clearsTurnScopedSystemUpdates } from "../../transcript-policy.js";
import { getHistoryLimitFromSessionKey, limitHistoryTurns } from "../history.js";
import { log } from "../logger.js";
import { describePastProjectMoves } from "../project-move-replay.js";
import { sanitizeSessionHistory, validateReplayTurns } from "../replay-history.js";
import { bindToolResultPromptProjectionKeys } from "../tool-result-projection-key.js";
import type { EmbeddedAttemptExecutionPhaseInput } from "./attempt-execution-types.js";
import { loadAttemptSessionEntryAfterQuotaMaintenance } from "./attempt-transcript-helpers.js";
import { projectCopiedForkMessages } from "./fork-working-context.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";
import { resolveEmbeddedSessionContextLimits } from "./session-context-limits.js";

function boundSettledFinalizationMessages(attempt: EmbeddedRunAttemptInternalParams) {
  // Selection never reads entry timestamps, and these entries are neither persisted nor
  // sent to the model. Context-engine messages may omit timestamps, so use a fixed value.
  const timestamp = new Date(0).toISOString();
  const requests: ModelContextRequest[] = attempt.settledTurnFinalizationMessages!.map(
    (message, index) => ({
      entry: {
        type: "message",
        id: String(index),
        parentId: index ? String(index - 1) : null,
        timestamp,
        message,
        seq: index,
      },
      omitCheckpoint: false,
    }),
  );
  const project = (request: ModelContextRequest) => {
    const message = request.entry.type === "message" ? request.entry.message : undefined;
    return message?.role === "toolResult" && request.toolResultOmission
      ? { ...message, content: [{ type: "text" as const, text: request.toolResultOmission }] }
      : message!;
  };
  // Reuse hydration's byte/event and tool-body omission policy on the selected view.
  // Only model input changes; the receipt-bearing writer remains the original manager.
  return selectBoundedModelRequests(
    requests,
    (selected) =>
      new Map(
        selected.map((request) => [
          request.entry,
          Buffer.byteLength(JSON.stringify(project(request)), "utf8") + 1,
        ]),
      ),
    resolveEmbeddedSessionContextLimits(attempt),
  ).map(project);
}

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
  let explicitChatFork = false;
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
    const storePath = resolveSessionStorePathCore(attempt.config?.session?.store, {
      agentId: sessionAgentId,
    });
    const sessionEntry =
      attempt.sessionKey && attempt.sessionPersistence !== "detached" && !isSettledTurnFinalization
        ? await loadAttemptSessionEntryAfterQuotaMaintenance(
            { agentId: sessionAgentId, storePath, sessionKey: attempt.sessionKey },
            assertActive,
          )
        : undefined;
    const inherited =
      attempt.sessionKey &&
      sessionEntry?.forkSource &&
      sessionEntry.forkSource.entryId === undefined &&
      isExplicitChatFork(attempt.sessionKey, sessionEntry.createdVia, sessionEntry.spawnDepth)
        ? sessionManager[sessionManagerInheritedMessages]?.()
        : undefined;
    explicitChatFork = inherited !== undefined;
    const prior = await sanitizeSessionHistory({
      ...replayContext(),
      messages: bindToolResultPromptProjectionKeys(
        isSettledTurnFinalization && attempt.settledTurnFinalizationMessages
          ? boundSettledFinalizationMessages(attempt)
          : inherited
            ? projectCopiedForkMessages(activeSession.messages, inherited)
            : activeSession.messages,
        input.prepared.sessionRuntime.toolResultPromptProjectionState,
      ),
      allowedToolNames: replayAllowedToolNames,
      sessionManager,
    });
    input.setup.prepStages.mark("history-sanitize");
    cacheTrace?.recordStage("session:sanitized", { messages: prior });
    // Keep each keyed user row intact until prompt() has resolved the current turn.
    // The stream boundary merges projected rows for providers requiring alternation.
    let validated = await validateReplayTurns({
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
      assertActive();
      if (
        sessionEntry?.priorWorkspace &&
        attempt.model.api === "openai-completions" &&
        !isLocalBaseUrl(attempt.model.baseUrl)
      ) {
        validated = describePastProjectMoves(validated);
      }
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
    if (limited.length > 0 || prior.length > 0 || isSettledTurnFinalization) {
      activeSession.agent.state.messages = limited;
    }
  }

  const prompt = orphanRepair?.contextEnginePrompt ?? attempt.prompt ?? "";
  const { messages, systemPrompt, ...prepared } = await prepareHarnessContextEnginePrompt({
    ...attempt,
    contextEngine: activeContextEngine,
    agentId: sessionAgentId,
    appendOnlyRuntimeContext: transcriptPolicy.appendOnlyRuntimeContext,
    clearsTurnScopedSystemUpdates: clearsTurnScopedSystemUpdates(
      transcriptPolicy,
      attempt.model.api,
    ),
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
  // Seal restored model history once; transcript admission already seals retained messages.
  for (const message of messages) {
    if (
      (message.role === "assistant" || message.role === "user" || message.role === "toolResult") &&
      !isOwnedTranscriptPayload(message)
    ) {
      freezeJsonSnapshot(message);
    }
  }
  activeSession.agent.state.messages = messages;
  if (systemPrompt !== systemPromptText) {
    setSystemPrompt(systemPrompt);
  }
  return { ...prepared, ...(explicitChatFork ? { explicitChatFork: true as const } : {}) };
}
