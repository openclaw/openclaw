import {
  getSessionActorStorageBinding,
  type captureSessionActorStorageOwner,
  runWithSessionActorStorage,
  type SessionActorStorageBinding,
} from "../../config/sessions/session-actor-storage-binding.js";
import type {
  SessionActorStorageReads,
  SessionActorStorageWrites,
} from "../../config/sessions/session-actor-storage-contract.js";
import { readSessionActorStorageResult } from "../../config/sessions/session-actor-storage-result.js";
import { IncognitoSessionMissingError } from "../../state/incognito-session-error.js";
import type { ContextEngineTurnOutboxWorkerStore } from "./context-engine-turn-outbox.js";

/** Plugin callbacks run outside the FIFO; only their intent acknowledgments reenter it. */
export function openMemoryContextEngineTurnOutboxStore(
  scope: {
    agentId: string;
    storePath: string;
    sessionKey?: string;
    sessionId?: string;
    sessionActor?: SessionActorStorageBinding;
  },
  source: NonNullable<ReturnType<typeof captureSessionActorStorageOwner>>,
): ContextEngineTurnOutboxWorkerStore {
  const { authority } = source;
  const sessionKey =
    scope.sessionKey ??
    (scope.sessionId
      ? source.owner?.readSessionById(scope.sessionId, authority)?.sessionKey
      : undefined);
  const selected = () => {
    const binding = getSessionActorStorageBinding({}) ?? source.binding;
    return binding?.agentId === source.agentId &&
      binding.path === source.path &&
      binding.actor.target.sessionKey === sessionKey
      ? binding
      : undefined;
  };
  const run = async <T>(
    operation: (binding: SessionActorStorageBinding) => Promise<T>,
  ): Promise<T> => {
    const binding = selected();
    if (binding) {
      return operation(binding);
    }
    const actor = sessionKey
      ? await source.owner?.acquireExisting(sessionKey, {
          assertCurrent: () => authority.assertCurrent(),
          assertReadable: () => authority.assertCurrent(),
        })
      : undefined;
    if (!actor) {
      throw new IncognitoSessionMissingError();
    }
    try {
      return await operation({ actor, authority, agentId: source.agentId, path: source.path });
    } finally {
      await actor.release();
    }
  };
  const mutate = <Key extends keyof SessionActorStorageWrites>(
    type: Key,
    input: SessionActorStorageWrites[Key]["input"],
  ) =>
    run(async ({ actor }) =>
      readSessionActorStorageResult(await actor.storage!.mutate({ type, input }, authority)),
    );
  const read = <Key extends keyof SessionActorStorageReads>(
    type: Key,
    input: SessionActorStorageReads[Key]["input"],
  ) => run(({ actor }) => actor.storage!.read({ type, input }, authority));
  return {
    retain: (operation) =>
      run(({ actor }) =>
        actor.withPhase("context-engine-outbox", authority, ({ actor: held }) =>
          runWithSessionActorStorage(
            { actor: held, authority, agentId: source.agentId, path: source.path },
            operation,
          ),
        ),
      ),
    assertReadable() {
      const binding = selected();
      if (binding) {
        binding.actor.snapshot(authority);
        return;
      }
      if (!sessionKey || !source.owner?.readSession(sessionKey, authority)) {
        throw new IncognitoSessionMissingError();
      }
    },
    prepareRun: (input) => mutate("session.outbox.prepareRun", input),
    enqueueIntent: (input) => mutate("session.outbox.enqueueIntent", input),
    acceptIntent: (input) => mutate("session.outbox.acceptIntent", input),
    publishClosedTurn: (input) => mutate("session.outbox.publishClosedTurn", input),
    discardIntent: (input) => mutate("session.outbox.discardIntent", input),
    listPendingSessions: (input) => read("session.outbox.listPendingSessions", input),
    readNextPending: (input) => read("session.outbox.readNextPending", input),
    hasPending: (input) => read("session.outbox.hasPending", input),
    complete: async (advancementKey) => {
      await mutate("session.outbox.complete", { advancementKey });
    },
    recordFailure: async (advancementKey, message, attemptedAt) => {
      await mutate("session.outbox.recordFailure", { advancementKey, message, attemptedAt });
    },
  };
}
