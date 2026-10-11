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
import { readSessionTranscriptAnchorsAsync } from "../../config/sessions/session-transcript-anchor-read.js";
import {
  readSessionTranscriptModelContextAsync,
  type PreparedSessionTranscriptModelContext,
} from "../../config/sessions/session-transcript-context-read.js";
import { prepareSessionTranscriptHydration } from "../../config/sessions/session-transcript-hydration.js";
import {
  resolveSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
  withSessionContextAdmission,
} from "../../config/sessions/session-transcript-read-fence.js";
import { withSessionTranscriptReadSource } from "../../config/sessions/session-transcript-read-source.js";
import { readSessionTranscriptContextMessagesInWorker } from "../../config/sessions/session-transcript-read-worker-runtime.js";
import type { SessionHistoryWorkerLane } from "../../config/sessions/session-transcript-worker-resources.js";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import { captureSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import {
  captureOwnedTranscriptWriteAssertion,
  getOwnedSessionTranscriptActor,
  getOwnedSessionTranscriptWriterFence,
} from "../../config/sessions/transcript-write-context.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import { captureSessionManagerIncognitoBinding } from "./session-manager-incognito-scope.js";
import {
  prepareSessionManagerMemoryHydration,
  prepareSessionManagerMemoryRead,
} from "./session-manager-memory-read.js";

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
  return {
    ...prepareSessionManagerMemoryHydration(incognitoBinding, limits, signal),
    incognitoBinding,
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
  const selected = captureSessionManagerIncognitoBinding(readTarget, manager);
  if (selected) {
    const reader = prepareSessionManagerMemoryRead(selected, options.signal);
    const context = await reader.read("session.history.context", {
      sessionId: readTarget.sessionId,
      admission,
      through,
      limits,
    });
    reader.assertCurrent();
    const value = await consume(context);
    reader.assertCurrent();
    return value;
  }
  const result = await withSessionContextAdmission(readTarget, admission, () =>
    readSessionTranscriptModelContextAsync(
      readTarget,
      consume,
      admission,
      options.signal,
      through,
      limits,
      true,
      options.prepared,
    ),
  );
  options.signal?.throwIfAborted();
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
  const selected = captureSessionManagerIncognitoBinding(captured);
  if (selected) {
    const reader = prepareSessionManagerMemoryRead(selected, signal);
    const snapshot = await reader.read("session.history.context-messages", {
      sessionId: captured.sessionId,
      admission,
    });
    const messages = (function* () {
      for (const message of snapshot.messages) {
        reader.assertCurrent();
        yield message;
      }
    })();
    try {
      reader.assertCurrent();
      const value = await read(messages, snapshot.header);
      reader.assertCurrent();
      return value;
    } finally {
      messages.return(undefined);
    }
  }
  return withSessionContextAdmission(captured, admission, async () => {
    const assertCurrent = () => {
      signal?.throwIfAborted();
      assertOwned();
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
      const snapshot = readSessionTranscriptContextMessages(
        captured,
        (messages, header, version) => ({
          messages: [...messages],
          header,
          version,
        }),
      );
      assertCurrent();
      const result = await consumeSnapshot(snapshot);
      assertCurrent();
      if (!readSessionManagerActorTranscript(captured, snapshot.version)) {
        if (admission) {
          validateSessionTranscriptContextAdmission(captured, admission);
        } else {
          validateSessionTranscriptContextVersion(captured, snapshot.version);
        }
      }
      assertCurrent();
      return result;
    };
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
