import {
  withSessionEntryReadOnlyInWorker,
  type SessionEntryReadWorkerOwner,
} from "../../config/sessions/session-entry-read-runtime.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { prepareMemoryAcpSessionEntryRead } from "./session-meta-memory.js";
import { captureAcpSessionReadContext } from "./session-meta-read-context.js";
import type {
  AcpSessionEntryReadInput,
  PreparedAcpSessionEntryRead,
} from "./session-meta-read.types.js";
import { readAcpSessionMetaForEntries } from "./session-meta-readonly.js";
import { resolveSessionStorePathForAcp, type AcpSessionStoreEntry } from "./session-meta-store.js";

export type {
  AcpSessionEntryPreparer,
  AcpSessionEntryReadInput,
  PreparedAcpSessionEntryRead,
} from "./session-meta-read.types.js";

/** Retain the canonical session source through its lifecycle-bound ACP metadata join. */
export async function readAcpSessionEntryAsync(
  params: AcpSessionEntryReadInput,
): Promise<AcpSessionStoreEntry | null> {
  return withAcpSessionEntryRead(params, (entry) => entry);
}

/** Retain a private source through the caller's asynchronous cleanup operation. */
export function prepareAcpSessionEntryRead(
  params: AcpSessionEntryReadInput,
): Promise<PreparedAcpSessionEntryRead> | undefined {
  return isIncognitoSessionKey(params.sessionKey.trim())
    ? prepareMemoryAcpSessionEntryRead(params)
    : undefined;
}

/** The consuming owner can verify the exact selected physical source before custody ends. */
export async function withAcpSessionEntryRead<T>(
  params: AcpSessionEntryReadInput,
  consume: (
    entry: AcpSessionStoreEntry | null,
    owner: SessionEntryReadWorkerOwner | undefined,
  ) => T | Promise<T>,
  options: { currentMetadata?: true } = {},
): Promise<T> {
  const input = { ...params };
  const sessionKey = input.sessionKey.trim();
  input.assertCurrent?.();
  if (!sessionKey) {
    return consume(null, undefined);
  }
  const memory = prepareAcpSessionEntryRead(input);
  if (memory) {
    const prepared = await memory;
    try {
      prepared.assertCurrent();
      return await consume(prepared.session, undefined);
    } finally {
      prepared.release();
    }
  }
  const { cfg, env, databasePath, assertCurrent } = await captureAcpSessionReadContext(input);
  assertCurrent();
  const target = resolveSessionStorePathForAcp({ ...input, sessionKey, cfg, env });
  const storeSessionKey = target.storeSessionKey;
  return await withSessionEntryReadOnlyInWorker(
    { agentId: target.agentId, storePath: target.storePath, sessionKey: storeSessionKey, env },
    assertCurrent,
    async (read, owner) => {
      const entry = read.ok ? read.value : undefined;
      const [acp] = await readAcpSessionMetaForEntries(
        {
          entries: [{ sessionKey: storeSessionKey, agentId: target.agentId, entry }],
          cfg,
          env,
          databasePath,
        },
        { current: options.currentMetadata },
      );
      assertCurrent();
      return consume(
        {
          cfg,
          agentId: target.agentId,
          storePath: target.storePath,
          sessionKey,
          storeSessionKey,
          entry,
          acp: acp ?? undefined,
          ...(!read.ok ? { storeReadFailed: true } : {}),
        },
        owner,
      );
    },
  );
}

export async function readAcpSessionMetaAsync(
  params: AcpSessionEntryReadInput,
): Promise<SessionAcpMeta | undefined> {
  return (await readAcpSessionEntryAsync({ ...params, clone: false }))?.acp;
}
