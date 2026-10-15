import type { SessionActor } from "../../config/sessions/session-actor-contract.js";
import { sameSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import {
  captureOwnedTranscriptWriteAssertion,
  getOwnedSessionTranscriptActor,
  SessionTranscriptWriterClaimReboundError,
} from "../../config/sessions/transcript-write-context.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import type { SessionManagerCore } from "./session-manager-core.js";
import {
  captureSessionManagerWriteAssertion,
  runSessionManagerWrite,
  withSessionManagerWrite,
  type SessionManagerWriteAdmission,
} from "./session-manager-write-admission.js";

type SessionManagerActorAppendAdmission = {
  actor: SessionActor;
  options: OpenClawAgentDatabaseOptions;
  assertCurrent(): void;
};

export type SessionManagerAppendAdmission =
  | SessionManagerActorAppendAdmission
  | SessionManagerWriteAdmission;

/** The manager owns preparation and view adoption; the actor owns each database command. */
export async function withSessionManagerAppend<T>(
  manager: Pick<SessionManagerCore, "getSessionTarget" | "getSessionId">,
  append: (admission?: SessionManagerAppendAdmission) => T | Promise<T>,
  nativeMaintenance = false,
): Promise<T> {
  const target = manager.getSessionTarget();
  const binding = !nativeMaintenance && target ? getOwnedSessionTranscriptActor(target) : undefined;
  if (!binding || !target || binding.actor.target.database.kind === "memory") {
    // Released unbound SDK managers and the dedicated compaction transaction keep their owner.
    return withSessionManagerWrite(manager, append);
  }
  const { actor } = binding;
  const identity = { ...target };
  const assertManager = captureSessionManagerWriteAssertion(manager);
  const assertOwned = captureOwnedTranscriptWriteAssertion(identity);
  const assertCurrent = () => {
    assertManager?.();
    assertOwned();
    actor.assertCurrent();
    if (!sameSessionTranscriptTargetBinding(identity, manager.getSessionTarget())) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
  };
  assertCurrent();
  const options = binding.database;
  return runSessionManagerWrite(manager, () => {
    assertCurrent();
    return actor.withPhase(
      "session-manager.append",
      { assertCurrent, authorize: assertCurrent },
      async () => append({ actor, options, assertCurrent }),
    );
  });
}
