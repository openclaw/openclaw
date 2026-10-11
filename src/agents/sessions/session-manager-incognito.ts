import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import type { SessionTranscriptContextVersion } from "../../config/sessions/session-accessor.sqlite-contract.js";
import {
  readSessionTranscriptContextMessages,
  type readSessionTranscriptModelContext,
  validateSessionTranscriptContextAdmission,
  validateSessionTranscriptContextVersion,
} from "../../config/sessions/session-accessor.sqlite-model-context.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import type {
  SessionModelContextLimits,
  SessionTranscriptContextSnapshot,
} from "../../config/sessions/session-history-read.types.js";
import type { IncognitoContextReadResult } from "../../config/sessions/session-incognito-history-contract.js";
import { readSessionTranscriptAnchorsAsync } from "../../config/sessions/session-transcript-anchor-read.js";
import {
  readSessionTranscriptModelContextAsync,
  type PreparedSessionTranscriptModelContext,
} from "../../config/sessions/session-transcript-context-read.js";
import {
  prepareIncognitoSessionTranscriptHydration,
  prepareSessionTranscriptHydration,
} from "../../config/sessions/session-transcript-hydration.js";
import {
  resolveSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
  withSessionContextAdmission,
} from "../../config/sessions/session-transcript-read-fence.js";
import { withSessionTranscriptReadSource } from "../../config/sessions/session-transcript-read-source.js";
import { readSessionTranscriptContextMessagesInWorker } from "../../config/sessions/session-transcript-read-worker-runtime.js";
import type { SessionHistoryWorkerLane } from "../../config/sessions/session-transcript-worker-resources.js";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import {
  captureSessionTranscriptTargetBinding,
  type CapturedSessionTranscriptTargetBinding,
} from "../../config/sessions/transcript-target-binding.js";
import {
  captureOwnedTranscriptWriteAssertion,
  getOwnedSessionTranscriptActor,
  getOwnedSessionTranscriptWriterFence,
} from "../../config/sessions/transcript-write-context.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import { getOpenIncognitoAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import {
  captureSessionManagerIncognitoAdmissionAssertion,
  captureSessionManagerIncognitoBinding,
} from "./session-manager-incognito-scope.js";

/** Exact owner postimages can validate metadata, never replace bounded payload reads. */
export function readSessionManagerActorTranscript(
  target: SessionTranscriptRuntimeTarget,
  version: SessionTranscriptContextVersion | undefined,
) {
  // Anchors do not carry roles; an admitted user boundary keeps its full validator.
  if (!version || resolveSessionTranscriptReadFence(target)) {
    return undefined;
  }
  const binding = getOwnedSessionTranscriptActor(target);
  if (!binding) {
    return undefined;
  }
  const assertCurrent = captureOwnedTranscriptWriteAssertion(target);
  const state = binding.actor.snapshot({ assertCurrent, authorize: assertCurrent });
  const fence = getOwnedSessionTranscriptWriterFence({ sessionTarget: target });
  if (
    !state ||
    state.target.sessionKey !== target.sessionKey ||
    state.entry?.sessionId !== target.sessionId ||
    (fence &&
      (state.entry.lifecycleRevision !== fence.expectedLifecycleRevision ||
        state.entry.activeWriterRunId !== fence.expectedWriterRunId)) ||
    state.transcript.anchorsState !== "resident" ||
    state.transcript.version.generation !== version.generation ||
    state.transcript.version.rawSeq !== version.rawSeq ||
    state.transcript.version.updatedAt !== version.updatedAt
  ) {
    return undefined;
  }
  return state.transcript;
}

/** SessionManager planning uses the same actor as its subsequent metadata command. */
export function prepareSessionManagerHydration(
  source: SessionTranscriptRuntimeTarget,
  options: {
    limits?: { maxBytes: number; maxEvents: number };
    signal?: AbortSignal;
    manager?: object;
    retarget?: boolean;
    lane?: SessionHistoryWorkerLane;
  } = {},
) {
  const { limits, signal, manager, retarget = false, lane } = options;
  const target = captureSessionTranscriptTargetBinding(source);
  const incognitoBinding = captureSessionManagerIncognitoBinding(target, manager, retarget);
  if (!incognitoBinding) {
    return { ...prepareSessionTranscriptHydration(target, limits, signal, lane), incognitoBinding };
  }
  const assertAdmission = captureSessionManagerIncognitoAdmissionAssertion(incognitoBinding);
  const actor = incognitoBinding.actor;
  const assertOwned = captureOwnedTranscriptWriteAssertion(target);
  const assertCurrent = () => {
    assertAdmission();
    assertOwned();
  };
  assertCurrent();
  const lifecycleRevision = actor.sessions.readSharing(target.sessionKey)?.entry?.lifecycleRevision;
  const hydration = prepareIncognitoSessionTranscriptHydration({
    actor,
    authority: { assertCurrent },
    target: {
      sessionKey: target.sessionKey,
      sessionId: target.sessionId,
      lifecycleRevision,
      admission: resolveSessionTranscriptReadFence(target),
    },
    limits,
    signal,
  });
  // Keep the manager's captured writer binding and environment across hydration adoption.
  return { ...hydration, target, incognitoBinding };
}

function prepareSessionManagerIncognitoContext(
  target: SessionTranscriptRuntimeTarget,
  signal?: AbortSignal,
  manager?: object,
) {
  const binding = captureSessionManagerIncognitoBinding(target, manager);
  if (!binding) {
    return undefined;
  }
  const assertAdmission = captureSessionManagerIncognitoAdmissionAssertion(binding);
  assertAdmission();
  const actor = binding.actor;
  const assertOwned = captureOwnedTranscriptWriteAssertion(target);
  const claim = actor.sessions.captureCurrent(target.sessionKey);
  const entry = actor.sessions.readSharing(target.sessionKey)?.entry;
  const input = {
    sessionKey: target.sessionKey,
    sessionId: target.sessionId,
    lifecycleRevision: entry?.lifecycleRevision,
    ...(!entry && { allowMissing: true as const }),
    admission: resolveSessionTranscriptReadFence(target),
  };
  const assertCurrent = () => {
    assertAdmission();
    signal?.throwIfAborted();
    assertOwned();
    claim.assertCurrent();
    actor.assertReadable();
  };
  const authority = { assertCurrent };
  const checked = async <Value>(pending: Promise<IncognitoContextReadResult<Value>>) => {
    const result = await pending;
    assertCurrent();
    if (!result.ok) {
      throw new SessionTranscriptReadFenceError(result.message);
    }
    return result.value;
  };
  return {
    binding: { actor, authority, target: input },
    retain: async <T>(operation: () => Promise<T>) => {
      const value = await actor.sessions.withSharedState(operation);
      assertCurrent();
      return value;
    },
    readMessages: () =>
      checked(
        actor.sessions.history(
          authority,
          {
            type: "session.history.native-context",
            input,
          },
          signal,
        ),
      ),
    validate: (version?: SessionTranscriptContextVersion) =>
      checked(
        actor.sessions.history(
          authority,
          {
            type: "session.history.native-context-current",
            input: { ...input, version },
          },
          signal,
        ),
      ),
    assertCurrent,
  };
}

function captureNativeContextOwner(target: CapturedSessionTranscriptTargetBinding) {
  const pathname = resolveIncognitoOpenClawAgentSqlitePath(target);
  const readOwner = () => getOpenIncognitoAgentDatabase(target.agentId, pathname);
  const owner = readOwner();
  return () => {
    if (readOwner() !== owner) {
      throw new SessionTranscriptReadFenceError(
        "Session transcript incognito database owner is no longer current",
      );
    }
  };
}

export async function readSessionManagerModelContextAsync<T>(
  target: SessionTranscriptRuntimeTarget,
  options: {
    admission?: UserTurnTranscriptAdmissionReceipt;
    signal?: AbortSignal;
    through?: TranscriptEntryAnchor;
    limits?: SessionModelContextLimits;
    prepared?: PreparedSessionTranscriptModelContext;
  },
  consume: (context: ReturnType<typeof readSessionTranscriptModelContext>) => T,
  manager?: object,
): Promise<T> {
  const readTarget = captureSessionTranscriptTargetBinding(target);
  const receipt = options.admission ?? resolveSessionTranscriptReadFence(readTarget);
  const admission = receipt ? { ...receipt } : undefined;
  const through = options.through ? { ...options.through } : undefined;
  const limits = options.limits ? { ...options.limits } : undefined;
  options.signal?.throwIfAborted();
  const actor = withSessionContextAdmission(readTarget, admission, () =>
    prepareSessionManagerIncognitoContext(readTarget, options.signal, manager),
  );
  if (actor) {
    return readSessionTranscriptModelContextAsync(
      readTarget,
      consume,
      admission,
      options.signal,
      through,
      limits,
      actor.binding,
    );
  }
  const native =
    isIncognitoSessionKey(readTarget.sessionKey) ||
    isIncognitoOpenClawAgentSqlitePath(readTarget.storePath, readTarget);
  const assertNative = native ? captureNativeContextOwner(readTarget) : undefined;
  const result = await withSessionContextAdmission(readTarget, admission, () =>
    readSessionTranscriptModelContextAsync(
      readTarget,
      (context) => {
        assertNative?.();
        return consume(context);
      },
      admission,
      options.signal,
      through,
      limits,
      undefined,
      true,
      options.prepared,
    ),
  );
  options.signal?.throwIfAborted();
  assertNative?.();
  return result;
}

export async function readSessionManagerContextAsync<T>(
  target: SessionTranscriptRuntimeTarget,
  read: (messages: Iterable<AgentMessage>, header: unknown) => T | Promise<T>,
  options: { admission?: UserTurnTranscriptAdmissionReceipt; signal?: AbortSignal },
): Promise<T> {
  const captured = captureSessionTranscriptTargetBinding(target);
  const receipt = options.admission ?? resolveSessionTranscriptReadFence(captured);
  const admission = receipt ? { ...receipt } : undefined;
  const assertOwned = captureOwnedTranscriptWriteAssertion(captured);
  const signal = options.signal;
  signal?.throwIfAborted();
  assertOwned();
  return withSessionContextAdmission(captured, admission, async () => {
    const actor = prepareSessionManagerIncognitoContext(captured, signal);
    const native =
      isIncognitoSessionKey(captured.sessionKey) ||
      isIncognitoOpenClawAgentSqlitePath(captured.storePath, captured);
    const assertNative = native && !actor ? captureNativeContextOwner(captured) : undefined;
    const assertCurrent = () => {
      signal?.throwIfAborted();
      assertOwned();
      actor?.assertCurrent();
      assertNative?.();
    };
    const consumeSnapshot = async (
      snapshot: SessionTranscriptContextSnapshot,
      assertReaderCurrent?: () => void,
    ) => {
      const messages = (function* () {
        for (const message of snapshot.messages) {
          assertCurrent();
          assertReaderCurrent?.();
          yield message;
        }
      })();
      try {
        return await read(messages, snapshot.header);
      } finally {
        messages.return(undefined);
      }
    };
    const consume = async () => {
      assertCurrent();
      const snapshot = actor
        ? await actor.readMessages()
        : readSessionTranscriptContextMessages(captured, (messages, header, version) => ({
            messages: [...messages],
            header,
            version,
          }));
      assertCurrent();
      const result = await consumeSnapshot(snapshot);
      assertCurrent();
      if (!readSessionManagerActorTranscript(captured, snapshot.version)) {
        if (actor) {
          await actor.validate(snapshot.version);
        } else if (admission) {
          validateSessionTranscriptContextAdmission(captured, admission);
        } else {
          validateSessionTranscriptContextVersion(captured, snapshot.version);
        }
      }
      assertCurrent();
      return result;
    };
    if (actor) {
      return actor.retain(consume);
    }
    return withSessionTranscriptReadSource(
      captured,
      consume,
      async ({ scope, expectedIdentity, owner, assertCurrent: assertReadOwner }) => {
        const readTarget = {
          ...scope,
          sessionId: captured.sessionId,
          sessionKey: captured.sessionKey,
        };
        const assertDurable = () => {
          assertCurrent();
          assertReadOwner();
        };
        assertDurable();
        const snapshot = await readSessionTranscriptContextMessagesInWorker(
          readTarget,
          admission,
          signal,
          expectedIdentity,
        );
        assertDurable();
        const result = await consumeSnapshot(snapshot, () => owner.assertCurrent());
        assertDurable();
        if (readSessionManagerActorTranscript(captured, snapshot.version)) {
          return result;
        }
        let accepted: { value: T } | undefined;
        await readSessionTranscriptAnchorsAsync(
          readTarget,
          { entryIds: [], contextValidation: { version: snapshot.version, admission } },
          signal,
          (facts) => {
            assertDurable();
            if (!facts.contextValidated && (snapshot.version || admission)) {
              throw new SessionTranscriptReadFenceError(
                "Session transcript changed during context read",
              );
            }
            accepted = { value: result };
          },
        );
        if (!accepted) {
          throw new SessionTranscriptReadFenceError(
            "Session transcript changed during context read",
          );
        }
        return accepted.value;
      },
      signal,
    );
  });
}
