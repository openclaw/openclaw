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
import type { AcpSessionMetaMutationFields } from "./session-meta-access.types.js";
import type { AcpSessionControlBinding } from "./session-meta-control.types.js";
import { assertAcpSessionMutationEntry } from "./session-meta-entry.kernel.js";
import { selectAcpSessionRowForStoreEntry } from "./session-meta-keys.js";
import { rowToAcpSessionMeta } from "./session-meta-readonly.js";
import { readSessionEntryFromStore } from "./session-meta-store.js";
import { applyAcpSessionMutation } from "./session-meta-write.kernel.js";
import type { AcpSessionMutationCommit } from "./session-meta-write.types.js";

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
  for (const source of current.sources) {
    if (legacyAcpMigrationBindingMatches(source, current.entry)) {
      recordLegacyAcpMigrationCompletion(params.database, source, params.now);
    }
  }
}

export async function upsertAcpSessionMetaNative(
  params: AcpSessionMetaMutationFields & {
    assertCommitAllowed?: () => void;
    sessionKey: string;
    agentId?: string;
    cfg?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    databasePath?: string;
    skipMaintenance?: boolean;
    takeCacheOwnership?: boolean;
  },
): Promise<SessionEntry | null> {
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
        current ? mergeSessionEntry(preparedEntry, { acp: current }) : entry,
      );
    },
    { env: params.env, path: params.databasePath },
  );
  const publish = (
    publishedSessionKey: string,
    publishedEntry: SessionEntry | undefined,
    decision: AcpSessionMutationCommit["decision"],
  ) => {
    return runOpenClawStateWriteTransaction(
      (database) => {
        params.assertCommitAllowed?.();
        consumeLegacyAcpMigrationSources({
          database: database.db,
          agentId: storeEntry.agentId,
          storePath,
          sessionKey: publishedSessionKey,
          entry: publishedEntry,
          expectedControlBinding: params.expectedControlBinding,
          env: params.env,
          now: updatedAt,
        });
        applyAcpSessionMutation(database.db, {
          agentId: storeEntry.agentId,
          storageSessionKey,
          sessionKey: publishedSessionKey,
          entry: publishedEntry,
          currentRowKey,
          decision,
        });
        sessionChanges.emit(
          { agentId: storeEntry.agentId, sessionKey: publishedSessionKey },
          database.db,
        );
      },
      { env: params.env, path: params.databasePath },
    );
  };
  const metaToPersist = nextMeta;
  if (metaToPersist === undefined) {
    return current ? mergeSessionEntry(entry, { acp: current }) : (entry ?? null);
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
    publish(patched?.sessionKey ?? storageSessionKey, patched?.entry ?? entry, { kind: "clear" });
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
  // The entry patch settles before this authoritative publication.
  publish(persisted.sessionKey, persisted.entry, { kind: "set", meta: metaToPersist });
  return mergeSessionEntry(persisted.entry, { acp: metaToPersist });
}
