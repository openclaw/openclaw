/** Prepares the restored transcript at the LLM boundary for one attempt. */
import { resolveUserTimezone } from "../../date-time.js";
import { relocateCurrentRuntimeContextCarrierToTail } from "../../internal-runtime-context.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import type { AgentSession } from "../../sessions/index.js";
import type { TranscriptPolicy } from "../../transcript-policy.js";
import {
  replayTrailingEntriesForOrphanRepair,
  resolveOrphanRepairPlan,
} from "./attempt-orphan-repair.js";
import { repairAttemptToolUseResultPairing } from "./attempt-transcript-helpers.js";
import { normalizeMessagesForLlmBoundary } from "./attempt.llm-boundary.js";
import { detachPrePersistedCurrentUserTurn } from "./pre-persisted-user-turn.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type SessionBoundaryAttempt = Pick<
  EmbeddedRunAttemptParams,
  | "config"
  | "onUserMessagePersistenceInvalidated"
  | "prompt"
  | "suppressNextUserMessagePersistence"
  | "trigger"
  | "userTurnTranscriptRecorder"
>;

type LlmBoundaryOptions = NonNullable<Parameters<typeof normalizeMessagesForLlmBoundary>[1]>;

type CurrentUserTimestampOverride = NonNullable<LlmBoundaryOptions["currentUserTimestampOverride"]>;

export function prepareEmbeddedAttemptSessionBoundary(input: {
  activeSession: Pick<AgentSession, "agent">;
  attempt: SessionBoundaryAttempt;
  getUserTranscriptContexts: () => LlmBoundaryOptions["userTranscriptContexts"];
  isOpenAIResponsesApi: boolean;
  isRawModelRun: boolean;
  preparedUserTurnMessage: AgentMessage | undefined;
  sessionManager: ReturnType<typeof guardSessionManager>;
  setActiveSessionSystemPrompt: (systemPrompt: string) => void;
  transcriptPolicy: Pick<TranscriptPolicy, "repairToolUseResultPairing">;
}): {
  boundaryTimezone: string | undefined;
  includeBoundaryTimestamp: boolean;
  orphanRepair: ReturnType<typeof resolveOrphanRepairPlan>;
  setCurrentUserTimestampOverride: (override: CurrentUserTimestampOverride | undefined) => void;
} {
  const { activeSession, attempt, isRawModelRun, sessionManager } = input;
  if (isRawModelRun) {
    // Raw probes measure only the requested provider prompt. Restored history,
    // queued work, and the normal system prompt would contaminate it.
    activeSession.agent.reset();
    input.setActiveSessionSystemPrompt("");
  }

  const orphanRepair = isRawModelRun
    ? undefined
    : resolveOrphanRepairPlan({
        sessionManager,
        prompt: attempt.prompt,
        trigger: attempt.trigger,
      });
  if (orphanRepair?.removeLeaf) {
    if (orphanRepair.messageEntry.parentId) {
      sessionManager.branch(orphanRepair.messageEntry.parentId);
    } else {
      sessionManager.resetLeaf();
    }
    replayTrailingEntriesForOrphanRepair(sessionManager, orphanRepair.trailingEntries);
    // The old canonical user turn is gone. Its persistence suppression must not
    // discard the merged replacement prompt.
    sessionManager.clearNextUserMessagePersistenceSuppression?.();
    attempt.onUserMessagePersistenceInvalidated?.();
    const ctxMessages = sessionManager.buildSessionContext().messages;
    activeSession.agent.state.messages = input.transcriptPolicy.repairToolUseResultPairing
      ? repairAttemptToolUseResultPairing(ctxMessages, input.isOpenAIResponsesApi)
      : ctxMessages;
  }

  detachPrePersistedCurrentUserTurn({
    activeSession,
    preparedUserTurnMessage: input.preparedUserTurnMessage,
    suppressNextUserMessagePersistence: attempt.suppressNextUserMessagePersistence,
    userTurnAlreadyPersisted: attempt.userTurnTranscriptRecorder?.hasPersisted() === true,
  });

  // This is the single timestamping source for user messages sent to the LLM.
  // Raw probes retain exact prompt bytes.
  const boundaryTimezone = isRawModelRun
    ? undefined
    : resolveUserTimezone(attempt.config?.agents?.defaults?.userTimezone);
  const includeBoundaryTimestamp =
    !isRawModelRun && attempt.config?.agents?.defaults?.envelopeTimestamp !== "off";
  let currentUserTimestampOverride: CurrentUserTimestampOverride | undefined;
  const buildBoundaryOptions = (): LlmBoundaryOptions => {
    if (isRawModelRun) {
      return { projectPersistedSenderContext: false };
    }
    const userTranscriptContexts = input.getUserTranscriptContexts();
    return {
      ...(boundaryTimezone ? { timezone: boundaryTimezone } : {}),
      ...(includeBoundaryTimestamp ? {} : { includeTimestamp: false }),
      ...(userTranscriptContexts?.length ? { userTranscriptContexts } : {}),
      ...(currentUserTimestampOverride ? { currentUserTimestampOverride } : {}),
    };
  };

  if (typeof activeSession.agent.convertToLlm === "function") {
    const baseConvertToLlm = activeSession.agent.convertToLlm.bind(activeSession.agent);
    activeSession.agent.convertToLlm = async (messages) =>
      await baseConvertToLlm(
        // Wire-only relocation keeps the request append-only through the active
        // user turn without changing position-sensitive precheck normalization.
        relocateCurrentRuntimeContextCarrierToTail(
          normalizeMessagesForLlmBoundary(messages, buildBoundaryOptions()),
        ),
      );
  }

  return {
    boundaryTimezone,
    includeBoundaryTimestamp,
    orphanRepair,
    setCurrentUserTimestampOverride: (override) => {
      currentUserTimestampOverride = override;
    },
  };
}
