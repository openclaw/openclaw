import path from "node:path";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import { captureRuntimeConfigWithSource } from "../../config/runtime-config-capture-state.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { normalizeStoreSessionKey } from "../../config/sessions/store-entry.js";
import { resolveStateDir } from "../../config/state-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { tryProcessCwd } from "../../infra/safe-cwd.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import {
  parseAcpDatabaseSessionKeyCandidates,
  resolveReadableAcpSessionRow,
} from "./session-meta-keys.js";
import { rowToAcpSessionMeta } from "./session-meta-readonly.js";
import { resolveSessionStorePathForAcp } from "./session-meta-store.js";
import type { AcpSessionStoreEntry } from "./session-meta.js";

/** Join ACP metadata through the existing shared-state and physical session readers. */
export async function listAcpSessionEntries(params: {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  clone?: boolean;
  databasePath?: string;
}): Promise<AcpSessionStoreEntry[]> {
  const cwd = tryProcessCwd();
  const databasePath = params.databasePath ? path.resolve(params.databasePath) : undefined;
  const suppliedEnv = params.env ? cloneEnvWithPlatformSemantics(params.env) : undefined;
  const captured = params.cfg
    ? {
        config: captureRuntimeConfigWithSource(params.cfg, params.cfg),
        env: cloneEnvWithPlatformSemantics(process.env),
      }
    : await captureRuntimeConfigAsyncReader({ capture: true })();
  const cfg = captured.config;
  const env = suppliedEnv ?? captured.env;
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const assertCurrent = () => {
    if (tryProcessCwd() !== cwd) {
      throw new Error("ACP session listing working directory changed; retry the read.");
    }
  };
  assertCurrent();
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
