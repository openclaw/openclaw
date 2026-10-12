import { getSessionActorStorageBinding } from "../../config/sessions/session-actor-storage-binding.js";
import {
  withSessionEntryReadOnlyInWorker,
  type SessionEntryReadWorkerOwner,
} from "../../config/sessions/session-entry-read-runtime.js";
import type { IncognitoSessionActor } from "../../config/sessions/session-incognito-actor.js";
import { captureIncognitoSessionOperation } from "../../config/sessions/session-incognito-binding.js";
import type { IncognitoSessionAuthority } from "../../config/sessions/session-incognito-contract.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { prepareMemoryAcpSessionEntryRead } from "./session-meta-memory.js";
import { captureAcpSessionReadContext } from "./session-meta-read-context.js";
import type {
  AcpSessionEntryReadInput,
  PreparedAcpSessionEntryRead,
} from "./session-meta-read.types.js";
import {
  readAcpSessionMetaForEntries,
  readAcpSessionMetaForEntry,
} from "./session-meta-readonly.js";
import {
  readSessionEntryFromStore,
  resolveSessionStorePathForAcp,
  type AcpSessionStoreEntry,
} from "./session-meta-store.js";

export type {
  AcpSessionEntryPreparer,
  AcpSessionEntryReadInput,
  PreparedAcpSessionEntryRead,
} from "./session-meta-read.types.js";

/** Retain the canonical session source through its lifecycle-bound ACP metadata join. */
export async function readAcpSessionEntryAsync(
  params: AcpSessionEntryReadInput,
  incognito?: { actor: IncognitoSessionActor; authority: IncognitoSessionAuthority },
): Promise<AcpSessionStoreEntry | null> {
  return withAcpSessionEntryRead(params, (entry) => entry, {}, incognito);
}

/** Retain a bound private source through the caller's asynchronous cleanup operation. */
export function prepareAcpSessionEntryRead(
  params: AcpSessionEntryReadInput,
): Promise<PreparedAcpSessionEntryRead> | undefined {
  const memory = getSessionActorStorageBinding({ ...params, sessionKey: params.sessionKey.trim() });
  if (memory && params.sessionKey.trim()) {
    return prepareMemoryAcpSessionEntryRead(params, memory);
  }
  const binding = captureIncognitoSessionOperation(params);
  return binding && params.sessionKey.trim()
    ? prepareBoundAcpSessionEntryRead(params, binding)
    : undefined;
}

async function prepareBoundAcpSessionEntryRead(
  params: AcpSessionEntryReadInput,
  binding: { actor: IncognitoSessionActor; authority: IncognitoSessionAuthority },
): Promise<PreparedAcpSessionEntryRead & { assertDisclosureCurrent(): void }> {
  const { actor, authority } = binding;
  const input = { ...params, sessionKey: params.sessionKey.trim() };
  actor.assertCurrent();
  authority.assertCurrent();
  const context = captureAcpSessionReadContext(input);
  let acquired: PreparedAcpSessionEntryRead | undefined;
  try {
    const prepared = await actor.sessions.withSharedState(async () => {
      const captured = await context;
      const target = resolveSessionStorePathForAcp({ ...input, ...captured });
      if (target.agentId !== actor.agentId) {
        throw new Error("ACP read differs from its captured incognito actor");
      }
      const { prepareIncognitoAcpSessionEntryRead } =
        await import("./session-meta-worker-mutation.js");
      const source = await prepareIncognitoAcpSessionEntryRead({
        ...captured,
        actor,
        storePath: target.storePath,
        sessionKey: target.storeSessionKey,
        authority: {
          assertCurrent() {
            captured.assertCurrent();
            authority.assertCurrent();
          },
          authorize: (stage, facts) => authority.authorize?.(stage, facts),
        },
      });
      acquired = source;
      const assertDisclosureCurrent = () => {
        captured.assertCurrent();
        authority.assertCurrent();
        actor.assertReadable();
      };
      return {
        ...source,
        session: source.session ? { ...source.session, sessionKey: input.sessionKey } : null,
        assertDisclosureCurrent,
        assertCurrent() {
          source.assertCurrent();
          assertDisclosureCurrent();
        },
      };
    });
    prepared.assertCurrent();
    return prepared;
  } catch (error) {
    acquired?.release();
    throw error;
  }
}

/** The consuming owner can verify the exact selected physical source before custody ends. */
export async function withAcpSessionEntryRead<T>(
  params: AcpSessionEntryReadInput,
  consume: (
    entry: AcpSessionStoreEntry | null,
    owner: SessionEntryReadWorkerOwner | undefined,
  ) => T | Promise<T>,
  options: { currentMetadata?: true } = {},
  incognito?: { actor: IncognitoSessionActor; authority: IncognitoSessionAuthority },
): Promise<T> {
  const input = { ...params };
  const sessionKey = input.sessionKey.trim();
  input.assertCurrent?.();
  if (!sessionKey) {
    return consume(null, undefined);
  }
  const memory = getSessionActorStorageBinding({ ...input, sessionKey });
  if (memory) {
    const prepared = await prepareMemoryAcpSessionEntryRead(input, memory);
    try {
      prepared.assertCurrent();
      return await consume(prepared.session, undefined);
    } finally {
      prepared.release();
    }
  }
  const binding = incognito ?? captureIncognitoSessionOperation(input);
  if (binding) {
    const prepared = await prepareBoundAcpSessionEntryRead(input, binding);
    let value: T;
    try {
      prepared.assertCurrent();
      value = await consume(prepared.session, undefined);
      prepared.assertCurrent();
    } finally {
      prepared.release();
    }
    prepared.assertDisclosureCurrent();
    return value;
  }
  const { cfg, env, databasePath, assertCurrent } = await captureAcpSessionReadContext(input);
  assertCurrent();
  const target = resolveSessionStorePathForAcp({ ...input, sessionKey, cfg, env });
  const storeSessionKey = target.storeSessionKey;
  if (isIncognitoSessionKey(storeSessionKey)) {
    // Incognito retains its process-held native owner and nonyielding join until its cutover.
    const stored = readSessionEntryFromStore({ ...input, sessionKey, cfg, env });
    const acp = readAcpSessionMetaForEntry(
      {
        sessionKey: stored.storeSessionKey,
        agentId: stored.agentId,
        cfg,
        entry: stored.entry,
        env,
        databasePath,
      },
      { current: options.currentMetadata },
    );
    assertCurrent();
    return consume(
      { ...target, ...stored, storePath: target.storePath, sessionKey, acp },
      { kind: "native", assertCurrent },
    );
  }
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
