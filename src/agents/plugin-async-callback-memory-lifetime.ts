import { AsyncLocalStorage } from "node:async_hooks";
import { resolveStateDir } from "../config/paths.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  isIncognitoSessionKey,
  resolveIncognitoSessionExpiresAt,
} from "../shared/incognito-session-key.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import type { PluginCallbackMemoryLifetime } from "./plugin-async-callback-memory.js";
import type { PluginAsyncCallbackBinding } from "./plugin-async-callback-policy.js";

/** Observe only the already-admitted RAM database, never create/adopt a replacement. */
export async function capturePluginCallbackMemoryLifetime(
  binding: PluginAsyncCallbackBinding,
): Promise<PluginCallbackMemoryLifetime> {
  const agentId = parseAgentSessionKey(binding.childSessionKey)?.agentId;
  if (!agentId || !isIncognitoSessionKey(binding.childSessionKey)) {
    throw new Error("Callback requires an incognito child");
  }
  const env = { ...process.env, OPENCLAW_STATE_DIR: resolveStateDir() };
  const scope = {
    agentId,
    env,
    storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId, env }),
    sessionKey: binding.childSessionKey,
  };
  const source = getOpenClawAgentDatabaseIfOpen({ agentId, env, path: scope.storePath });
  if (!source) {
    throw new Error("Incognito callback session is unavailable");
  }
  let closed = false;
  const isCurrent = () =>
    !closed &&
    source.db.isOpen &&
    getOpenClawAgentDatabaseIfOpen({ agentId, env, path: scope.storePath })?.db === source.db;
  const assertCurrent = () => {
    if (!isCurrent()) {
      throw new Error("Incognito callback owner retired");
    }
  };
  const read = () =>
    withSessionEntryReadOnlyInWorker(scope, assertCurrent, async (result) => {
      if (!result.ok) {
        throw result.error;
      }
      return result.value;
    });
  const initial = await read();
  const expiresAt = initial && resolveIncognitoSessionExpiresAt(initial);
  if (
    !initial ||
    initial.sessionId !== binding.childSessionId ||
    initial.archivedAt !== undefined ||
    expiresAt === undefined ||
    expiresAt <= Date.now()
  ) {
    throw new Error("Incognito callback session is unavailable");
  }
  const revision = initial.lifecycleRevision ?? null;
  const runInOwner = AsyncLocalStorage.snapshot();
  const verify = () =>
    runInOwner(async () => {
      if (!isCurrent() || Date.now() >= expiresAt) {
        return false;
      }
      const entry = await read();
      return (
        isCurrent() &&
        entry?.sessionId === binding.childSessionId &&
        (entry.lifecycleRevision ?? null) === revision &&
        entry.archivedAt === undefined
      );
    });
  return {
    expiresAt,
    isCurrent,
    verify,
    onRetire(retire) {
      const retireOwner = () => {
        closed = true;
        retire();
      };
      const unsubscribeIdentity = onSessionIdentityMutation((mutation) => {
        if (
          mutation.agentId === agentId &&
          (mutation.previous.sessionId === binding.childSessionId ||
            mutation.previous.sessionKeys.includes(binding.childSessionKey))
        ) {
          retireOwner();
        }
      });
      const unsubscribeRows = sessionChanges.subscribeProjection((change) => {
        if (
          "sessionKey" in change &&
          (change.sessionKey !== binding.childSessionKey ||
            (change.agentId && change.agentId !== agentId) ||
            (change.storePath && change.storePath !== scope.storePath))
        ) {
          return;
        }
        // An observation failure is not a confirmed reset. Keep bounded work;
        // completion/delivery must still verify successfully before using it.
        // Do not include a potentially private read error in logs.
        void verify().then(
          (valid) => {
            if (!valid) {
              retireOwner();
            }
          },
          () => {},
        );
      });
      return () => {
        closed = true;
        unsubscribeIdentity();
        unsubscribeRows();
      };
    },
  };
}
