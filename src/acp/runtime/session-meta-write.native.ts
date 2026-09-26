import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { patchSessionEntryWithKey } from "../../config/sessions/session-accessor.js";
import { readLegacyAcpMigrationContext } from "../../config/sessions/session-accessor.sqlite-acp-provenance.js";
import {
  mergeSessionEntry,
  type SessionAcpMeta,
  type SessionEntry,
} from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  legacyAcpMigrationBindingMatches,
  recordLegacyAcpMigrationCompletion,
} from "../../infra/legacy-acp-migration-source.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type { AcpSessionControlBinding } from "./session-control-owner.js";
import { assertAcpSessionMutationEntry } from "./session-meta-entry.kernel.js";
import { selectAcpSessionRowForStoreEntry } from "./session-meta-keys.js";
import { clearLegacyEmbeddedAcpMetadata } from "./session-meta-legacy-cleanup.js";
import { rowToAcpSessionMeta } from "./session-meta-readonly.js";
import { readSessionEntryFromStore } from "./session-meta-store.js";
import { applyAcpSessionMutation } from "./session-meta-write.kernel.js";

function mergeAcpForReturn(entry: SessionEntry | undefined, acp: SessionAcpMeta): SessionEntry {
  return mergeSessionEntry(entry, { acp });
}

function sessionStoreUpdateOptions(params: {
  sessionKey: string;
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
}) {
  return {
    activeSessionKey: normalizeLowercaseStringOrEmpty(params.sessionKey),
    ...(params.skipMaintenance === true ? { skipMaintenance: true } : {}),
    ...(params.takeCacheOwnership === true ? { takeCacheOwnership: true } : {}),
  };
}

function consumeLegacyAcpMigrationSources(params: {
  database: DatabaseSync;
  agentId?: string;
  storePath: string;
  sessionKey: string;
  entry: SessionEntry | undefined;
  expectedControlBinding?: AcpSessionControlBinding;
  env?: NodeJS.ProcessEnv;
  now: number;
}): void {
  const current = readLegacyAcpMigrationContext(params);
  assertAcpSessionMutationEntry(
    current.entry,
    params.entry ?? null,
    params.expectedControlBinding,
    "legacy source consumption",
  );
  if (current.sources.length === 0) {
    return;
  }
  for (const source of current.sources) {
    if (legacyAcpMigrationBindingMatches(source, current.entry)) {
      recordLegacyAcpMigrationCompletion(params.database, source, params.now);
    }
  }
}

export async function upsertAcpSessionMetaNative(params: {
  assertCommitAllowed?: () => void;
  expectedControlBinding?: AcpSessionControlBinding;
  sessionKey: string;
  agentId?: string;
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
  now?: () => number;
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
  mutate: (
    current: SessionAcpMeta | undefined,
    entry: SessionEntry | undefined,
  ) => SessionAcpMeta | null | undefined;
}): Promise<SessionEntry | null> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }
  const storeEntry = readSessionEntryFromStore({
    sessionKey,
    agentId: params.agentId,
    cfg: params.cfg,
    env: params.env,
    clone: false,
  });
  if (!storeEntry.storePath) {
    return null;
  }
  const { entry, storePath } = storeEntry;
  const storageSessionKey = storeEntry.storeSessionKey;
  let current: SessionAcpMeta | undefined;
  let currentRowKey: string | undefined;
  let nextMeta: SessionAcpMeta | null | undefined;
  let preparedEntry: SessionEntry | undefined;
  const updatedAt = params.now?.() ?? Date.now();
  runOpenClawStateWriteTransaction(
    (database) => {
      params.assertCommitAllowed?.();
      const fresh = readLegacyAcpMigrationContext({
        agentId: storeEntry.agentId,
        storePath,
        sessionKey: storageSessionKey,
        env: params.env,
      });
      assertAcpSessionMutationEntry(
        fresh.entry,
        entry ?? null,
        params.expectedControlBinding,
        "metadata preparation",
      );
      const currentRow = selectAcpSessionRowForStoreEntry(
        database.db,
        storageSessionKey,
        storeEntry.agentId,
        storeEntry.cfg,
        entry,
      );
      currentRowKey = currentRow?.session_key;
      current = currentRow ? rowToAcpSessionMeta(currentRow) : undefined;
      preparedEntry = mergeSessionEntry(entry, {
        updatedAt,
        ...(entry ? {} : { lifecycleRevision: randomUUID() }),
      });
      nextMeta = params.mutate(
        current,
        current ? mergeAcpForReturn(preparedEntry, current) : entry,
      );
    },
    { env: params.env, path: params.databasePath },
  );
  const metaToPersist = nextMeta;
  if (metaToPersist === undefined) {
    return current ? mergeAcpForReturn(entry, current) : (entry ?? null);
  }
  if (metaToPersist === null) {
    const patched = entry
      ? await patchSessionEntryWithKey(
          {
            ...(storeEntry.agentId ? { agentId: storeEntry.agentId } : {}),
            storePath: storeEntry.storePath,
            sessionKey: storageSessionKey,
          },
          (currentEntry, context) => {
            assertAcpSessionMutationEntry(
              context.existingEntry,
              entry ?? null,
              params.expectedControlBinding,
              "entry mutation",
            );
            const next = { ...currentEntry };
            delete next.acp;
            return next;
          },
          {
            ...sessionStoreUpdateOptions({ ...params, sessionKey: storageSessionKey }),
            replaceEntry: true,
            assertCommitAllowed: params.assertCommitAllowed,
          },
        )
      : null;
    runOpenClawStateWriteTransaction(
      (database) => {
        params.assertCommitAllowed?.();
        consumeLegacyAcpMigrationSources({
          database: database.db,
          agentId: storeEntry.agentId,
          storePath,
          sessionKey: patched?.sessionKey ?? storageSessionKey,
          entry: patched?.entry ?? entry,
          expectedControlBinding: params.expectedControlBinding,
          env: params.env,
          now: updatedAt,
        });
        applyAcpSessionMutation(database.db, {
          agentId: storeEntry.agentId,
          storageSessionKey,
          sessionKey: patched?.sessionKey ?? storageSessionKey,
          entry: patched?.entry ?? entry,
          currentRowKey,
          decision: { kind: "clear" },
        });
        sessionChanges.emit(
          { agentId: storeEntry.agentId, sessionKey: patched?.sessionKey ?? storageSessionKey },
          database.db,
        );
      },
      { env: params.env, path: params.databasePath },
    );
    await clearLegacyEmbeddedAcpMetadata({
      agentId: storeEntry.agentId,
      storePath: storeEntry.storePath,
      sessionKeys: [storageSessionKey, patched?.sessionKey],
      expectedEntry: patched?.entry ?? entry ?? null,
      expectedControlBinding: params.expectedControlBinding,
      assertCommitAllowed: params.assertCommitAllowed,
    });
    return patched?.entry ?? null;
  }
  const persisted = await patchSessionEntryWithKey(
    {
      ...(storeEntry.agentId ? { agentId: storeEntry.agentId } : {}),
      storePath: storeEntry.storePath,
      sessionKey: storageSessionKey,
    },
    (currentEntry, context) => {
      assertAcpSessionMutationEntry(
        context.existingEntry,
        entry ?? null,
        params.expectedControlBinding,
        "entry mutation",
      );
      const next = mergeSessionEntry(currentEntry, {
        updatedAt,
      });
      delete next.acp;
      return next;
    },
    {
      ...sessionStoreUpdateOptions({ ...params, sessionKey: storageSessionKey }),
      fallbackEntry: preparedEntry,
      replaceEntry: true,
      assertCommitAllowed: params.assertCommitAllowed,
    },
  );
  if (!persisted) {
    return null;
  }
  await clearLegacyEmbeddedAcpMetadata({
    agentId: storeEntry.agentId,
    storePath: storeEntry.storePath,
    sessionKeys: [storageSessionKey, persisted.sessionKey],
    expectedEntry: persisted.entry,
    expectedControlBinding: params.expectedControlBinding,
    assertCommitAllowed: params.assertCommitAllowed,
  });
  runOpenClawStateWriteTransaction(
    (database) => {
      // The entry patch and legacy cleanup await before this authoritative publication.
      params.assertCommitAllowed?.();
      consumeLegacyAcpMigrationSources({
        database: database.db,
        agentId: storeEntry.agentId,
        storePath,
        sessionKey: persisted.sessionKey,
        entry: persisted.entry,
        expectedControlBinding: params.expectedControlBinding,
        env: params.env,
        now: updatedAt,
      });
      applyAcpSessionMutation(database.db, {
        agentId: storeEntry.agentId,
        storageSessionKey,
        sessionKey: persisted.sessionKey,
        entry: persisted.entry,
        currentRowKey,
        decision: { kind: "set", meta: metaToPersist },
      });
      sessionChanges.emit(
        { agentId: storeEntry.agentId, sessionKey: persisted.sessionKey },
        database.db,
      );
    },
    { env: params.env, path: params.databasePath },
  );
  return mergeAcpForReturn(persisted.entry, metaToPersist);
}
