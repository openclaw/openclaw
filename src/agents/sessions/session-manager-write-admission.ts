import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { captureOwnedTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../../shared/store-writer-queue.js";
import {
  withOpenClawAgentDatabaseAsync,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import type { SessionManagerCore } from "./session-manager-core.js";

// Detached managers have no database path; keep their existing write boundary keyed by owner.
const detachedWriterQueues = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionManagerDetachedWriterQueues"),
  () => new WeakMap<object, Map<string, StoreWriterQueue>>(),
);

export type SessionManagerWriteAdmission = {
  database: OpenClawAgentDatabase;
  options: OpenClawAgentDatabaseOptions;
};

/** Keep the manager operation, committed view adoption, and cleanup in one storage admission. */
export async function withSessionManagerWrite<T>(
  manager: Pick<SessionManagerCore, "getSessionTarget" | "getSessionId">,
  write: (admission?: SessionManagerWriteAdmission) => T | Promise<T>,
): Promise<T> {
  const target = manager.getSessionTarget();
  if (!target) {
    const sessionId = manager.getSessionId();
    const queues = detachedWriterQueues.get(manager) ?? new Map<string, StoreWriterQueue>();
    detachedWriterQueues.set(manager, queues);
    return await trackAsyncWork(() =>
      runQueuedStoreWrite({
        queues,
        storePath: "session",
        label: "detached session write admission",
        reentrant: true,
        fn: async () => {
          if (manager.getSessionTarget() || manager.getSessionId() !== sessionId) {
            throw new Error("Session manager identity changed before transcript write admission");
          }
          return await write();
        },
      }),
    );
  }
  const identity = { ...target };
  const assertCurrent = captureOwnedTranscriptWriteAssertion(identity);
  const options = toDatabaseOptions(resolveSqliteReadScope(identity));
  options.env = cloneEnvWithPlatformSemantics(options.env ?? process.env);
  options.env.OPENCLAW_STATE_DIR = resolveStateDir(options.env);
  options.path = resolveOpenClawAgentSqlitePath(options);
  // A tool's cancellation race or a void extension callback can return first.
  // Its existing runtime owner must still retain the admitted write.
  return await trackAsyncWork(() =>
    runOpenClawAgentWriteAdmission(
      options,
      () =>
        withOpenClawAgentDatabaseAsync(
          options,
          (database) => {
            const current = manager.getSessionTarget();
            if (
              !current ||
              current.agentId !== identity.agentId ||
              current.sessionId !== identity.sessionId ||
              current.sessionKey !== identity.sessionKey ||
              current.storePath !== identity.storePath
            ) {
              throw new Error("Session manager identity changed before transcript write admission");
            }
            // Each native kernel or worker command still validates live authority at commit.
            return write({ database, options });
          },
          assertCurrent,
        ),
      true,
    ),
  );
}
