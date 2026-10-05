import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "../../../../packages/agent-core/src/types.js";
import type { SessionTranscriptWriteScope } from "../../../config/sessions/session-accessor.sqlite-contract.js";
import { readSessionTranscriptAnchorsAsync } from "../../../config/sessions/session-transcript-anchor-read.js";
import { withSessionTranscriptReadSource } from "../../../config/sessions/session-transcript-read-source.js";
import {
  captureOwnedTranscriptWriteAssertion,
  getOwnedSessionTranscriptInitialWriter,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "../../../config/sessions/transcript-write-context.js";
import type { DatabaseFileIdentity } from "../../../infra/sqlite-worker-identity.js";
import { readNestedToolActivity } from "../../../sessions/nested-tool-activity.js";
import type {
  PersistedUserTurnMessage,
  UserTurnTranscriptRecorder,
} from "../../../sessions/user-turn-transcript.types.js";
import {
  AGENT_RUN_RESTART_ABORT_ERROR,
  AGENT_RUN_RESTART_ABORT_ERROR_CODE,
} from "../../run-termination.js";
import {
  sessionManagerPrepareCurrentTurnReplay,
  type CurrentTurnReplayWitness,
} from "../../sessions/session-manager-current-turn.js";
import { prepareSessionManagerHydration } from "../../sessions/session-manager-incognito.js";
import type { SessionEntry } from "../../sessions/session-manager-types.js";
import type { SessionManager } from "../../sessions/session-manager.js";

export type InitialUserTurnReplayPreparation = (
  signal?: AbortSignal,
) => Promise<((onAdmitted: () => void) => Promise<void>) | undefined>;

function isInterruptedTurnEntry(entry: SessionEntry, runId: string): boolean {
  if (entry.type === "custom_message") {
    return entry.customType === "openclaw:turn-aborted";
  }
  if (entry.type !== "message") {
    return false;
  }
  const message = entry.message;
  if (message.role === "custom") {
    return readNestedToolActivity(message)?.details.runId === runId;
  }
  if (Reflect.get(message, "__openclaw")?.runId !== runId) {
    return false;
  }
  if (message.role !== "assistant") {
    return message.role === "toolResult";
  }
  return (
    message.stopReason === "toolUse" ||
    (message.stopReason === "aborted" &&
      (message.errorCode !== undefined
        ? message.errorCode === AGENT_RUN_RESTART_ABORT_ERROR_CODE
        : message.errorMessage === AGENT_RUN_RESTART_ABORT_ERROR) &&
      message.content.every((part) => part.type === "text" && part.text === ""))
  );
}

/** Re-adopt the current turn without reopening arbitrary historical keyed users. */
export async function preparePersistedCurrentUserTurn(params: {
  sessionManager: SessionManager;
  message: PersistedUserTurnMessage | undefined;
  recorder: UserTurnTranscriptRecorder | undefined;
  runId: string;
  signal?: AbortSignal;
}): Promise<InitialUserTurnReplayPreparation | undefined> {
  const { sessionManager, message, recorder, runId } = params;
  const sessionTarget = sessionManager.getSessionTarget();
  if (!sessionTarget || !message?.idempotencyKey || !recorder) {
    return undefined;
  }
  const scope: typeof sessionTarget & SessionTranscriptWriteScope =
    withOwnedSessionTranscriptWriterFence(sessionTarget);
  const assertOwned = captureOwnedTranscriptWriteAssertion(scope);
  const initialWriter = getOwnedSessionTranscriptInitialWriter({ sessionTarget: scope });
  const reader = prepareSessionManagerHydration(scope, undefined, params.signal, sessionManager);
  let originalSource: { storePath: string; identity?: DatabaseFileIdentity } | undefined;
  const assertCurrent = () => {
    assertOwned();
    reader.assertCurrent();
  };
  const binding = reader.incognitoBinding;
  const incognito = binding && {
    actor: binding.actor,
    authority: { assertCurrent },
    target: { sessionKey: scope.sessionKey, sessionId: scope.sessionId },
  };
  const withSource = <T>(
    signal: AbortSignal | undefined,
    operation: (target: typeof scope, assertSource: () => void) => Promise<T>,
  ): Promise<T> => {
    assertCurrent();
    const native = () => operation(scope, assertCurrent);
    return binding
      ? binding.actor.sessions.withSharedState(native)
      : withSessionTranscriptReadSource(
          scope,
          native,
          ({ scope: captured, expectedIdentity, assertCurrent: assertSource }) => {
            originalSource ??= { storePath: captured.storePath, identity: expectedIdentity };
            if (
              captured.storePath !== originalSource.storePath ||
              expectedIdentity?.key !== originalSource.identity?.key ||
              expectedIdentity?.birthtime !== originalSource.identity?.birthtime
            ) {
              throw new Error(
                "Persisted user turn changed its database owner before replay admission",
              );
            }
            return operation(
              { ...scope, agentId: captured.agentId, storePath: captured.storePath },
              assertSource,
            );
          },
          signal,
        );
  };
  const validate = async (
    target: typeof scope,
    assertSource: () => void,
    prepared: CurrentTurnReplayWitness | undefined,
    signal: AbortSignal | undefined,
    consume: () => void,
  ) => {
    signal?.throwIfAborted();
    assertCurrent();
    const allowInitial = !prepared && Boolean(initialWriter) && !initialWriter?.committedFence;
    let accepted = false;
    await readSessionTranscriptAnchorsAsync(
      target,
      {
        entryIds: [],
        replayValidation: {
          expectedLifecycleRevision: scope.expectedLifecycleRevision,
          expectedWriterRunId: scope.expectedWriterRunId,
          allowInitial,
        },
        ...(prepared ? { contextValidation: { version: prepared.version } } : {}),
      },
      signal,
      (facts) => {
        assertSource();
        assertCurrent();
        if (
          facts.replayValidated !== "current" &&
          !(facts.replayValidated === "initial" && allowInitial && !initialWriter?.committedFence)
        ) {
          throw new SessionTranscriptWriterClaimReboundError();
        }
        if (prepared && !facts.contextValidated) {
          throw new Error("Persisted user turn changed before replay admission");
        }
        // Consume under the reader's writer FIFO and native mutation witness.
        consume();
        accepted = true;
      },
      incognito,
    );
    assertCurrent();
    if (!accepted) {
      throw new Error("Persisted user turn changed before replay admission");
    }
  };
  const readCurrentTurn = (
    signal: AbortSignal | undefined,
    consume: (prepared: CurrentTurnReplayWitness | undefined) => void,
  ) =>
    withSource(signal, async (target, assertSource) => {
      await sessionManager.reloadPersistedTranscriptAsync(signal);
      assertSource();
      assertCurrent();
      const prepared = await sessionManager[sessionManagerPrepareCurrentTurnReplay](
        (entry) => isInterruptedTurnEntry(entry, runId),
        (entry) =>
          entry?.type === "message" &&
          entry.message.role === "user" &&
          isDeepStrictEqual(entry.message, message),
        signal,
      );
      await validate(target, assertSource, prepared, signal, () => consume(prepared));
      return prepared;
    });
  const initial = await readCurrentTurn(params.signal, (prepared) => {
    if (prepared) {
      recorder.markRuntimePersisted(message, prepared.anchor, { appended: false });
    }
  });
  if (!initial) {
    return undefined;
  }
  // Hooks and compaction can intervene before the core consumes this turn once.
  let pending = true;
  return async (signal = params.signal) => {
    if (!pending) {
      return undefined;
    }
    const replaySignal =
      signal && params.signal && signal !== params.signal
        ? AbortSignal.any([signal, params.signal])
        : signal;
    const current = await readCurrentTurn(replaySignal, (prepared) => {
      if (
        !prepared ||
        prepared.anchor.entryId !== initial.anchor.entryId ||
        prepared.anchor.generation !== initial.anchor.generation
      ) {
        throw new Error("Persisted user turn changed before replay admission");
      }
    });
    return async (onAdmitted) => {
      await withSource(replaySignal, (target, assertSource) =>
        validate(target, assertSource, current, replaySignal, () => {
          if (!pending) {
            throw new Error("Persisted user turn replay was already consumed");
          }
          pending = false;
          onAdmitted();
        }),
      );
    };
  };
}

export function sessionMessagesContainIdempotencyKey(
  messages: AgentMessage[],
  idempotencyKey: string,
): boolean {
  return messages.some(
    (message) => "idempotencyKey" in message && message.idempotencyKey === idempotencyKey,
  );
}

export function reconcilePrePersistedCurrentUserTurn(params: {
  activeSession: { agent: { state: { messages: AgentMessage[] } } };
  currentUserTurnMessage: PersistedUserTurnMessage | undefined;
  durableUserTurnMessage: PersistedUserTurnMessage | undefined;
  userTurnAlreadyPersisted: boolean;
}): boolean {
  const idempotencyKey = params.currentUserTurnMessage?.idempotencyKey;
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    return false;
  }
  // Recorder state is process-local; after restart the durable keyed leaf is the
  // authoritative proof that this exact admitted turn was already persisted.
  const durableTurnMatches = params.durableUserTurnMessage?.idempotencyKey === idempotencyKey;
  if (!params.userTurnAlreadyPersisted && !durableTurnMatches) {
    return false;
  }
  const messages = params.activeSession.agent.state.messages;
  const tail = messages.at(-1);
  const activeTailMatches =
    tail?.role === "user" && "idempotencyKey" in tail && tail.idempotencyKey === idempotencyKey;
  if (activeTailMatches) {
    // BTW snapshots represent prior conversation; keep the current user separate
    // until prompt submission reinjects it with the resolved runtime context.
    params.activeSession.agent.state.messages = messages.slice(0, -1);
  }
  // Excluded turns deliberately lack a model-context copy; writes still validate admission.
  return (
    activeTailMatches ||
    durableTurnMatches ||
    params.currentUserTurnMessage?.excludeFromContext === true
  );
}
