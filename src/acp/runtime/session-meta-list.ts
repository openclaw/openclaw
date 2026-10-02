import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { normalizeStoreSessionKey } from "../../config/sessions/store-entry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import {
  parseAcpDatabaseSessionKeyCandidates,
  resolveReadableAcpSessionRow,
} from "./session-meta-keys.js";
import { captureAcpSessionReadContext } from "./session-meta-read-context.js";
import { rowToAcpSessionMeta } from "./session-meta-readonly.js";
import { resolveSessionStorePathForAcp, type AcpSessionStoreEntry } from "./session-meta-store.js";

/** Join ACP metadata through the existing shared-state and physical session readers. */
export async function listAcpSessionEntries(params: {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  clone?: boolean;
  databasePath?: string;
}): Promise<AcpSessionStoreEntry[]> {
  const { cfg, env, databasePath, assertCurrent } = await captureAcpSessionReadContext(params);
  const result = await executeExistingOpenClawStateRead(
    { env, path: databasePath },
    { type: "acpSessions.list" },
  );
  assertCurrent();
  if (!result) {
    return [];
  }
  if (!result.ok || result.type !== "acpSessions.list") {
    throw new Error("Unexpected ACP session list read result");
  }
  const entries: AcpSessionStoreEntry[] = [];
  for (const row of result.rows) {
    for (const identity of parseAcpDatabaseSessionKeyCandidates(row.session_key)) {
      const sessionKey = identity.storeSessionKey;
      const { agentId, storePath } = resolveSessionStorePathForAcp({
        sessionKey,
        agentId: identity.agentId,
        cfg,
        env,
      });
      const storeSessionKey = normalizeStoreSessionKey(sessionKey);
      if (!storePath || !storeSessionKey) {
        continue;
      }
      const joined = await withSessionEntryReadOnlyInWorker(
        { agentId, storePath, sessionKey: storeSessionKey, env },
        assertCurrent,
        async (read) => {
          if (!read.ok || !read.value) {
            return undefined;
          }
          const entry = read.value;
          const readableRow = resolveReadableAcpSessionRow({ row, entry });
          return readableRow
            ? {
                cfg,
                agentId,
                storePath,
                sessionKey,
                storeSessionKey,
                entry,
                acp: rowToAcpSessionMeta(readableRow),
              }
            : undefined;
        },
      );
      if (joined) {
        entries.push(joined);
        break;
      }
    }
  }
  assertCurrent();
  return entries;
}
