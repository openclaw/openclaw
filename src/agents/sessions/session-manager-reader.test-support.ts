import assert from "node:assert/strict";
import { loadSessionEntryForAdmission } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import type { SessionActor } from "../../config/sessions/session-actor-contract.js";
import { createSessionActorFactory } from "../../config/sessions/session-actor-durable.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import type { SessionManager } from "./session-manager.js";

export async function withSelectedTranscriptReader<T>(
  target: Parameters<typeof SessionManager.openModelContextAsync>[0],
  run: (actor?: SessionActor) => Promise<T>,
  retainActor = false,
): Promise<T> {
  const { databaseClaim } = await loadSessionEntryForAdmission(target);
  let actor: SessionActor | undefined;
  try {
    assert(
      "kind" in databaseClaim && databaseClaim.kind === "worker" && databaseClaim.reader,
      "Expected admitted durable session reader",
    );
    const reader = databaseClaim.reader;
    const assertCurrent = () => reader.assertCurrent();
    if (retainActor) {
      const identity = readDatabasePathIdentitySync(reader.database.path);
      assert(identity.key.startsWith("file:"), "Expected a physical actor database");
      const acquired = await createSessionActorFactory(reader.database).acquire(
        {
          sessionKey: target.sessionKey,
          database: {
            kind: "file",
            physicalIdentity: identity.key.slice(5),
            birthtime: identity.birthtime,
            nativeLocation: reader.database.path,
          },
        },
        { assertCurrent, assertReadable: assertCurrent },
      );
      assert(!("kind" in acquired), "Expected a durable session actor");
      actor = acquired;
      await actor.read({ assertCurrent, authorize: assertCurrent });
    }
    return await withOwnedSessionTranscriptWrites(
      {
        sessionTarget: target,
        sessionReader: reader,
        ...(actor && { sessionActor: { actor, database: reader.database } }),
        withTranscriptWrite: async (write) => write(),
      },
      () => run(actor),
    );
  } finally {
    try {
      await actor?.release();
    } finally {
      await databaseClaim.release();
    }
  }
}
