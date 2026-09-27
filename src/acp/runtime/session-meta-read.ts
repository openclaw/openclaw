import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { normalizeStoreSessionKey } from "../../config/sessions/store-entry.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import {
  captureAcpSessionReadContext,
  type AcpSessionReadContextInput,
} from "./session-meta-read-context.js";
import {
  readAcpSessionMetaForEntries,
  readAcpSessionMetaForEntry,
} from "./session-meta-readonly.js";
import {
  readSessionEntryFromStore,
  resolveSessionStorePathForAcp,
  type AcpSessionStoreEntry,
} from "./session-meta-store.js";

export type AcpSessionEntryReadInput = AcpSessionReadContextInput & {
  sessionKey: string;
  agentId?: string;
  clone?: boolean;
};

/** Retain the canonical session source through its lifecycle-bound ACP metadata join. */
export async function readAcpSessionEntryAsync(
  params: AcpSessionEntryReadInput,
): Promise<AcpSessionStoreEntry | null> {
  const input = { ...params };
  const sessionKey = input.sessionKey.trim();
  input.assertCurrent?.();
  if (!sessionKey) {
    return null;
  }
  const { cfg, env, databasePath, assertCurrent } = await captureAcpSessionReadContext(input);
  assertCurrent();
  const target = resolveSessionStorePathForAcp({ ...input, sessionKey, cfg, env });
  const storeSessionKey = normalizeStoreSessionKey(target.storeSessionKey);
  if (isIncognitoSessionKey(storeSessionKey)) {
    // Incognito retains its process-held native owner and nonyielding join until its cutover.
    const stored = readSessionEntryFromStore({ ...input, sessionKey, cfg, env });
    const acp = readAcpSessionMetaForEntry({
      sessionKey: stored.storeSessionKey,
      agentId: stored.agentId,
      cfg,
      entry: stored.entry,
      env,
      databasePath,
    });
    assertCurrent();
    return { ...target, ...stored, storePath: target.storePath, sessionKey, acp };
  }
  return await withSessionEntryReadOnlyInWorker(
    { agentId: target.agentId, storePath: target.storePath, sessionKey: storeSessionKey, env },
    assertCurrent,
    async (read) => {
      const entry = read.ok ? read.value : undefined;
      const [acp] = await readAcpSessionMetaForEntries({
        entries: [{ sessionKey: storeSessionKey, agentId: target.agentId, entry }],
        cfg,
        env,
        databasePath,
      });
      assertCurrent();
      return {
        cfg,
        agentId: target.agentId,
        storePath: target.storePath,
        sessionKey,
        storeSessionKey,
        entry,
        acp: acp ?? undefined,
        ...(!read.ok ? { storeReadFailed: true } : {}),
      };
    },
  );
}

export async function readAcpSessionMetaAsync(
  params: AcpSessionEntryReadInput,
): Promise<SessionAcpMeta | undefined> {
  return (await readAcpSessionEntryAsync({ ...params, clone: false }))?.acp;
}
