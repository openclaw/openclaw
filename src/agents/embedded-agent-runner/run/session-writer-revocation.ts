import { applySessionEntryOperation } from "../../../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionActor } from "../../../config/sessions/session-actor-contract.js";
import { runWithSessionActorStorage } from "../../../config/sessions/session-actor-storage-binding.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import type { captureSessionManagerIncognitoBinding } from "../../sessions/session-manager-incognito-scope.js";

export async function revokeAgentSessionWriterClaim(params: {
  snapshot: {
    agentId?: string;
    entry: Pick<InternalSessionEntry, "lifecycleRevision">;
    sessionKey: string;
    storePath: string;
  };
  sessionId: string;
  runId: string;
  memory: ReturnType<typeof captureSessionManagerIncognitoBinding>;
  isCurrent: () => boolean;
  persistTerminal?: true;
}): Promise<boolean> {
  if (!params.isCurrent()) {
    return false;
  }
  const assertCurrent = () => {
    if (!params.isCurrent()) {
      throw new Error("Session writer cleanup owner changed");
    }
  };
  const revoke = () =>
    applySessionEntryOperation(
      {
        ...(params.snapshot.agentId ? { agentId: params.snapshot.agentId } : {}),
        sessionKey: params.snapshot.sessionKey,
        storePath: params.snapshot.storePath,
      },
      {
        kind: "writer-revoke",
        runId: params.runId,
        ...(params.persistTerminal ? { terminalAtMs: Date.now() } : {}),
        expected: {
          sessionId: params.sessionId,
          lifecycleRevision: params.snapshot.entry.lifecycleRevision,
          activeWriterRunId: params.runId,
        },
      },
      { preserveActivity: true, skipMaintenance: true, workerGuard: { assertCurrent } },
    );
  let actor: SessionActor | undefined;
  try {
    // Terminal cleanup keeps the captured storage factory, not its cancelled execution handle.
    actor = await params.memory?.acquire(false, {
      assertCurrent,
      assertReadable: assertCurrent,
    });
    if (params.memory && !actor) {
      return false;
    }
    const revoked =
      params.memory && actor
        ? await runWithSessionActorStorage(
            {
              actor,
              agentId: params.memory.database.agentId,
              path: params.memory.database.path,
              authority: { assertCurrent, authorize: assertCurrent },
            },
            revoke,
          )
        : await revoke();
    return (
      revoked?.sessionId === params.sessionId &&
      revoked.lifecycleRevision === params.snapshot.entry.lifecycleRevision &&
      revoked.activeWriterRunId === undefined
    );
  } catch (error) {
    if (!params.isCurrent()) {
      return false;
    }
    throw error;
  } finally {
    await actor?.release();
  }
}
