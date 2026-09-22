import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { withOpenClawAgentDatabaseWrite } from "../../state/openclaw-agent-db-write.js";
import type { SessionManager } from "./session-manager.js";

/** Keep synchronous session-manager mutations inside an awaited storage admission. */
export async function withSessionManagerWrite<T>(
  manager: Pick<SessionManager, "getSessionTarget">,
  write: () => T,
): Promise<T> {
  const target = manager.getSessionTarget();
  if (!target) {
    return write();
  }
  const identity = { ...target };
  const options = toDatabaseOptions(resolveSqliteReadScope(identity));
  // A tool's cancellation race or a void extension callback can return first.
  // Its existing runtime owner must still retain the admitted write.
  return await trackAsyncWork(() =>
    withOpenClawAgentDatabaseWrite(options, () => {
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
      // Existing synchronous persistence validates the exact live writer claim
      // after this wait, before committing; the captured identity grants nothing.
      return write();
    }),
  );
}
