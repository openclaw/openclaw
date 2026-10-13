import {
  getSessionActorStorageBinding,
  runWithSessionActorStorage,
  type SessionActorStorageBinding,
} from "../../config/sessions/session-actor-storage-binding.js";
import type { SessionActorStorageOutcome } from "../../config/sessions/session-actor-storage-contract.js";
import type { ContextEngineTurnOutboxWorkerStore } from "./context-engine-turn-outbox.js";

function committed<T>(outcome: SessionActorStorageOutcome<T>): T {
  if (outcome.kind === "rolled-back") {
    throw new Error(outcome.error.message);
  }
  return outcome.value;
}

/** Plugin callbacks run outside the FIFO; only their intent acknowledgments reenter it. */
export function openMemoryContextEngineTurnOutboxStore(
  binding: SessionActorStorageBinding,
): ContextEngineTurnOutboxWorkerStore {
  const { actor, authority } = binding;
  const storage = () =>
    (
      getSessionActorStorageBinding({
        agentId: binding.agentId,
        storePath: binding.path,
        sessionKey: actor.target.sessionKey,
      }) ?? binding
    ).actor.storage!;
  return {
    retain: (operation) =>
      actor.withPhase("context-engine-outbox", authority, ({ actor: held }) =>
        runWithSessionActorStorage({ ...binding, actor: held }, operation),
      ),
    assertReadable() {
      actor.snapshot(authority);
    },
    prepareRun: async (input) =>
      committed(await storage().mutate({ type: "session.outbox.prepareRun", input }, authority)),
    enqueueIntent: async (input) =>
      committed(await storage().mutate({ type: "session.outbox.enqueueIntent", input }, authority)),
    acceptIntent: async (input) =>
      committed(await storage().mutate({ type: "session.outbox.acceptIntent", input }, authority)),
    publishClosedTurn: async (input) =>
      committed(
        await storage().mutate({ type: "session.outbox.publishClosedTurn", input }, authority),
      ),
    discardIntent: async (input) =>
      committed(await storage().mutate({ type: "session.outbox.discardIntent", input }, authority)),
    listPendingSessions: (input) =>
      storage().read({ type: "session.outbox.listPendingSessions", input }, authority),
    readNextPending: (input) =>
      storage().read({ type: "session.outbox.readNextPending", input }, authority),
    hasPending: (input) => storage().read({ type: "session.outbox.hasPending", input }, authority),
    complete: async (advancementKey) => {
      committed(
        await storage().mutate(
          { type: "session.outbox.complete", input: { advancementKey } },
          authority,
        ),
      );
    },
    recordFailure: async (advancementKey, message, attemptedAt) => {
      committed(
        await storage().mutate(
          { type: "session.outbox.recordFailure", input: { advancementKey, message, attemptedAt } },
          authority,
        ),
      );
    },
  };
}
