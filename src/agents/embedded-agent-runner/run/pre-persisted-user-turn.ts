import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "../../../../packages/agent-core/src/types.js";
import type { SessionTranscriptWriteScope } from "../../../config/sessions/session-accessor.sqlite-contract.js";
import type { SessionTranscriptRuntimeTarget } from "../../../config/sessions/session-accessor.types.js";
import { readSessionTranscriptAnchorsAsync } from "../../../config/sessions/session-transcript-anchor-read.js";
import { resolveSessionTranscriptReadFence } from "../../../config/sessions/session-transcript-read-fence.js";
import { withSessionTranscriptReadSource } from "../../../config/sessions/session-transcript-read-source.js";
import type { TranscriptEntryAnchor } from "../../../config/sessions/transcript-entry-anchor.js";
import {
  captureOwnedTranscriptWriteAssertion,
  getOwnedSessionTranscriptInitialWriter,
  getOwnedSessionTranscriptReader,
  type InitialSessionTranscriptWriter,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "../../../config/sessions/transcript-write-context.js";
import { readNestedToolActivity } from "../../../sessions/nested-tool-activity.js";
import type {
  PersistedUserTurnMessage,
  UserTurnTranscriptRecorder,
} from "../../../sessions/user-turn-transcript.types.js";
import {
  AGENT_RUN_RESTART_ABORT_ERROR,
  AGENT_RUN_RESTART_ABORT_ERROR_CODE,
} from "../../run-termination.js";
import { sessionManagerReloadTranscriptCohort } from "../../sessions/session-manager-core.js";
import {
  sessionManagerPrepareCurrentTurnReplay,
  type CurrentTurnReplaySelection,
} from "../../sessions/session-manager-current-turn.js";
import { prepareSessionManagerHydration } from "../../sessions/session-manager-incognito.js";
import type { SessionEntry } from "../../sessions/session-manager-types.js";
import type {
  PreparedSessionTranscriptReload,
  SessionManagerTranscriptCohort,
} from "../../sessions/session-manager-view-types.js";
import type { SessionManager } from "../../sessions/session-manager.js";

export type InitialUserTurnReplayPreparation = (
  signal?: AbortSignal,
) => Promise<((onAdmitted: () => void) => Promise<void>) | undefined>;

type CurrentTurnReplayWitness = CurrentTurnReplaySelection & { anchor: TranscriptEntryAnchor };
type InitialPersistedUserTurn = { anchor: TranscriptEntryAnchor | undefined };

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

function selectCurrentUserTurnFromCohort(params: {
  sessionManager: SessionManager;
  message: PersistedUserTurnMessage;
  runId: string;
  prepared: PreparedSessionTranscriptReload;
  assertView: () => void;
  allowInitial: boolean;
  initialWriter: InitialSessionTranscriptWriter | undefined;
}): { current: CurrentTurnReplayWitness | undefined } | undefined {
  const { sessionManager, prepared, assertView } = params;
  assertView();
  const facts = prepared.kind === "bounded" ? prepared.transcript : undefined;
  if (
    !facts ||
    (facts.replayValidated !== "current" &&
      !(
        facts.replayValidated === "initial" &&
        params.allowInitial &&
        !params.initialWriter?.committedFence
      ))
  ) {
    throw new SessionTranscriptWriterClaimReboundError();
  }
  const entryId = sessionManager.resolveCurrentTurnEntryId((entry) =>
    isInterruptedTurnEntry(entry, params.runId),
  );
  const entry = entryId ? sessionManager.getEntry(entryId) : undefined;
  // The hint selects an anchor, never the current turn. Omitted ancestry keeps its fresh fallback.
  if (entryId && !entry) {
    return undefined;
  }
  const matchesUser =
    entry?.type === "message" &&
    entry.message.role === "user" &&
    isDeepStrictEqual(entry.message, params.message);
  const anchor = facts.anchors.find((candidate) => candidate.entryId === entryId);
  if (matchesUser && !anchor) {
    return undefined;
  }
  return {
    current:
      matchesUser && anchor
        ? {
            entryId: anchor.entryId,
            anchor,
            version: prepared.snapshot.version,
            assertCurrent: assertView,
          }
        : undefined,
  };
}

/** The receipt selects a hint; initial replay still consumes freshly hydrated persisted bytes. */
export function prepareInitialPersistedUserTurnCohort(params: {
  target: SessionTranscriptRuntimeTarget;
  message: PersistedUserTurnMessage | undefined;
  recorder: UserTurnTranscriptRecorder | undefined;
  runId: string;
}) {
  const { message, recorder } = params;
  const hint = recorder?.getAdmissionReceipt()?.entryId;
  if (!message?.idempotencyKey || !recorder || !hint) {
    return undefined;
  }
  const scope: SessionTranscriptRuntimeTarget & SessionTranscriptWriteScope =
    withOwnedSessionTranscriptWriterFence(params.target);
  const owner = getOwnedSessionTranscriptReader(scope);
  if (!owner) {
    return undefined;
  }
  const assertOwned = captureOwnedTranscriptWriteAssertion(scope);
  const initialWriter = getOwnedSessionTranscriptInitialWriter({ sessionTarget: scope });
  const allowInitial = Boolean(initialWriter) && !initialWriter?.committedFence;
  const selection: SessionManagerTranscriptCohort["selection"] = {
    sessionKey: scope.sessionKey,
    entryIds: [hint],
    includeMessagePresence: true,
    replayValidation: {
      expectedLifecycleRevision: scope.expectedLifecycleRevision,
      expectedWriterRunId: scope.expectedWriterRunId,
      allowInitial,
      admission: resolveSessionTranscriptReadFence(scope),
    },
  };
  let initial: InitialPersistedUserTurn | undefined;
  let messagePresence: boolean | undefined;
  return {
    selection,
    consume(
      sessionManager: SessionManager,
      prepared: PreparedSessionTranscriptReload,
      assertView: () => void,
    ) {
      assertOwned();
      owner.assertCurrent();
      messagePresence =
        prepared.kind === "bounded" ? prepared.transcript?.messagePresence : undefined;
      const selected = selectCurrentUserTurnFromCohort({
        sessionManager,
        message,
        runId: params.runId,
        prepared,
        assertView,
        allowInitial,
        initialWriter,
      });
      if (selected) {
        if (selected.current) {
          recorder.markRuntimePersisted(message, selected.current.anchor, { appended: false });
        }
        initial = { anchor: selected.current?.anchor };
      }
    },
    readInitial: () => initial,
    readMessagePresence: () => messagePresence,
  };
}

/** Re-adopt the current turn without reopening arbitrary historical keyed users. */
export async function preparePersistedCurrentUserTurn(params: {
  sessionManager: SessionManager;
  message: PersistedUserTurnMessage | undefined;
  recorder: UserTurnTranscriptRecorder | undefined;
  runId: string;
  signal?: AbortSignal;
  initial?: InitialPersistedUserTurn;
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
  const reader = prepareSessionManagerHydration(scope, {
    signal: params.signal,
    manager: sessionManager,
  });
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
          ({ scope: captured, assertCurrent: assertSource }) =>
            operation(
              { ...scope, agentId: captured.agentId, storePath: captured.storePath },
              assertSource,
            ),
          signal,
        );
  };
  const validate = async (
    target: typeof scope,
    assertSource: () => void,
    prepared: CurrentTurnReplaySelection | undefined,
    signal: AbortSignal | undefined,
    consume: (witness: CurrentTurnReplayWitness | undefined) => void,
  ) => {
    signal?.throwIfAborted();
    assertCurrent();
    const allowInitial = !prepared && Boolean(initialWriter) && !initialWriter?.committedFence;
    let accepted = false;
    await readSessionTranscriptAnchorsAsync(
      target,
      {
        entryIds: prepared ? [prepared.entryId] : [],
        replayValidation: {
          expectedLifecycleRevision: scope.expectedLifecycleRevision,
          expectedWriterRunId: scope.expectedWriterRunId,
          allowInitial,
          admission: resolveSessionTranscriptReadFence(target),
        },
        ...(prepared ? { contextValidation: { version: prepared.version } } : {}),
      },
      signal,
      (facts) => {
        assertSource();
        assertCurrent();
        prepared?.assertCurrent();
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
        const anchor = facts.anchors[0];
        consume(prepared && anchor ? { ...prepared, anchor } : undefined);
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
      const matchesUser = (entry: SessionEntry | undefined) =>
        entry?.type === "message" &&
        entry.message.role === "user" &&
        isDeepStrictEqual(entry.message, message);
      const select = () =>
        sessionManager[sessionManagerPrepareCurrentTurnReplay](
          (entry) => isInterruptedTurnEntry(entry, runId),
          matchesUser,
          signal,
        );
      let witness: CurrentTurnReplayWitness | undefined;
      const accept = (current: CurrentTurnReplayWitness | undefined) => {
        witness = current;
        consume(current);
      };
      if (getOwnedSessionTranscriptReader(target)) {
        const allowInitial = Boolean(initialWriter) && !initialWriter?.committedFence;
        const hint = sessionManager.resolveCurrentTurnEntryId((entry) =>
          isInterruptedTurnEntry(entry, runId),
        );
        let consumed = false;
        await sessionManager[sessionManagerReloadTranscriptCohort](
          {
            sessionKey: scope.sessionKey,
            entryIds: hint ? [hint] : [],
            replayValidation: {
              expectedLifecycleRevision: scope.expectedLifecycleRevision,
              expectedWriterRunId: scope.expectedWriterRunId,
              allowInitial,
              admission: resolveSessionTranscriptReadFence(target),
            },
          },
          (prepared, assertView) => {
            assertSource();
            assertCurrent();
            const selected = selectCurrentUserTurnFromCohort({
              sessionManager,
              message,
              runId,
              prepared,
              assertView,
              allowInitial,
              initialWriter,
            });
            if (selected) {
              consumed = true;
              accept(selected.current);
            }
          },
          signal,
        );
        if (consumed) {
          return witness;
        }
      }
      await sessionManager.reloadPersistedTranscriptAsync(signal);
      assertSource();
      assertCurrent();
      await validate(target, assertSource, await select(), signal, accept);
      return witness;
    });
  const initial = params.initial
    ? params.initial.anchor
    : (
        await readCurrentTurn(params.signal, (prepared) => {
          if (prepared) {
            recorder.markRuntimePersisted(message, prepared.anchor, { appended: false });
          }
        })
      )?.anchor;
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
    replaySignal?.throwIfAborted();
    const accept = (prepared: CurrentTurnReplayWitness | undefined, onAdmitted?: () => void) => {
      if (
        !prepared ||
        prepared.anchor.entryId !== initial.entryId ||
        prepared.anchor.generation !== initial.generation
      ) {
        throw new Error("Persisted user turn changed before replay admission");
      }
      if (onAdmitted) {
        if (!pending) {
          throw new Error("Persisted user turn replay was already consumed");
        }
        pending = false;
        onAdmitted();
      }
    };
    assertCurrent();
    // Read once at core entry; prompt preparation does not reserve a database incarnation.
    return async (onAdmitted) => {
      await readCurrentTurn(replaySignal, (prepared) => accept(prepared, onAdmitted));
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
