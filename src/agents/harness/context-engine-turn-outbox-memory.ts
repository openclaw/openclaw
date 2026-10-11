import {
  getSessionActorStorageBinding,
  type captureSessionActorStorageOwner,
  runWithSessionActorStorage,
  type SessionActorStorageBinding,
} from "../../config/sessions/session-actor-storage-binding.js";
import type { SessionActorStorageOutcome } from "../../config/sessions/session-actor-storage-contract.js";
import { IncognitoSessionMissingError } from "../../state/incognito-session-error.js";
import type { ContextEngineTurnOutboxWorkerStore } from "./context-engine-turn-outbox.js";

function committed<T>(outcome: SessionActorStorageOutcome<T>): T {
  if (outcome.kind === "rolled-back") {
    throw new Error(outcome.error.message);
  }
  return outcome.value;
}

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
    prepareRun: async (input) =>
      run(async ({ actor }) =>
        committed(
          await actor.storage!.mutate({ type: "session.outbox.prepareRun", input }, authority),
        ),
      ),
    enqueueIntent: async (input) =>
      run(async ({ actor }) =>
        committed(
          await actor.storage!.mutate({ type: "session.outbox.enqueueIntent", input }, authority),
        ),
      ),
    acceptIntent: async (input) =>
      run(async ({ actor }) =>
        committed(
          await actor.storage!.mutate({ type: "session.outbox.acceptIntent", input }, authority),
        ),
      ),
    publishClosedTurn: async (input) =>
      run(async ({ actor }) =>
        committed(
          await actor.storage!.mutate(
            { type: "session.outbox.publishClosedTurn", input },
            authority,
          ),
        ),
      ),
    discardIntent: async (input) =>
      run(async ({ actor }) =>
        committed(
          await actor.storage!.mutate({ type: "session.outbox.discardIntent", input }, authority),
        ),
      ),
    listPendingSessions: (input) =>
      run(({ actor }) =>
        actor.storage!.read({ type: "session.outbox.listPendingSessions", input }, authority),
      ),
    readNextPending: (input) =>
      run(({ actor }) =>
        actor.storage!.read({ type: "session.outbox.readNextPending", input }, authority),
      ),
    hasPending: (input) =>
      run(({ actor }) =>
        actor.storage!.read({ type: "session.outbox.hasPending", input }, authority),
      ),
    complete: async (advancementKey) => {
      await run(async ({ actor }) =>
        committed(
          await actor.storage!.mutate(
            { type: "session.outbox.complete", input: { advancementKey } },
            authority,
          ),
        ),
      );
    },
    recordFailure: async (advancementKey, message, attemptedAt) => {
      await run(async ({ actor }) =>
        committed(
          await actor.storage!.mutate(
            {
              type: "session.outbox.recordFailure",
              input: { advancementKey, message, attemptedAt },
            },
            authority,
          ),
        ),
      );
    },
  };
}
