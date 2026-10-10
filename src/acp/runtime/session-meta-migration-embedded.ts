import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DoctorSqliteMaintenanceAuthority } from "../../commands/doctor-sqlite-maintenance-lock.js";
import { rewriteDoctorSessionEntries } from "../../commands/doctor/shared/session-entry-rewrite.js";
import { scanDoctorSessionEntriesTolerant } from "../../config/sessions/session-accessor.js";
import { readExactSessionEntryRowValidated } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { parseSqliteSessionEntryRecord } from "../../config/sessions/session-entry-json.js";
import { isPerAgentSessionStoreConfig } from "../../config/sessions/session-store-config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import {
  hasLegacyAcpMigrationCompletion,
  prepareLegacyAcpMigrationSource,
  recordLegacyAcpMigrationCompletion,
} from "../../infra/legacy-acp-migration-source.js";
import type { ExistingAgentDatabaseTarget } from "../../infra/session-sqlite-migration-readers.js";
import { createVerifiedSqliteSnapshot } from "../../infra/sqlite-snapshot.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  isSameOpenClawAgentDatabasePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { sanitizeOpenClawStateLeaseRows } from "../../state/openclaw-state-snapshot-sanitizer.js";
import {
  buildAcpDatabaseSessionKey,
  selectAcpSessionRow,
  upsertAcpSessionMetaRow,
} from "./session-meta-keys.js";
import { selectAcpMigrationRowForStoreEntry } from "./session-meta-migration-keys.js";
import { rowToAcpSessionMeta } from "./session-meta-readonly.js";
import { resolveSessionStorePathForAcp } from "./session-meta-store.js";
import { bindAcpSessionMeta } from "./session-meta-write.kernel.js";

function sameEmbeddedAcpSource(current: SessionEntry | undefined, expected: SessionEntry): boolean {
  return (
    current !== undefined &&
    current.sessionId === expected.sessionId &&
    current.lifecycleRevision === expected.lifecycleRevision &&
    current.sessionStartedAt === expected.sessionStartedAt &&
    current.updatedAt === expected.updatedAt &&
    isDeepStrictEqual(current.acp, expected.acp)
  );
}

/** Import embedded SQLite metadata before retiring the source field. Receipts prevent replay after closure. */
export async function repairEmbeddedAcpSessionMetaForDoctor(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  apply: boolean;
  authority?: DoctorSqliteMaintenanceAuthority;
  targets: readonly ExistingAgentDatabaseTarget[];
}) {
  const report: { found: number; repaired: number; backups: string[]; warnings: string[] } = {
    found: 0,
    repaired: 0,
    backups: [],
    warnings: [],
  };
  for (const target of params.targets) {
    params.authority?.assertCurrent();
    const scope = { agentId: target.agentId, storePath: target.storePath, env: params.env };
    const entries = new Map<string, SessionEntry>();
    try {
      const identity = readDatabasePathIdentitySync(target.sqlitePath);
      scanDoctorSessionEntriesTolerant(scope, ({ entry, sessionKey, recoveredFromProjections }) => {
        if (!recoveredFromProjections && entry.acp != null) {
          entries.set(sessionKey, entry);
        }
      });
      report.found += entries.size;
      if (!params.apply || !entries.size) {
        continue;
      }
      const authority = params.authority;
      if (!authority) {
        throw new Error("Embedded ACP repair requires Doctor maintenance authority.");
      }
      const assertSourceCurrent = () => {
        authority.assertCurrent();
        assertExistingDatabaseIdentity(target.sqlitePath, identity.key, identity.birthtime);
      };
      assertSourceCurrent();
      const backup = await createVerifiedSqliteSnapshot({
        sourcePath: target.sqlitePath,
        targetPath: `${target.sqlitePath}.pre-acp-metadata-migration-${randomUUID()}.bak`,
        preserveRowIds: true,
        transform: sanitizeOpenClawStateLeaseRows,
        validate: (snapshot) => {
          for (const [sessionKey, entry] of entries) {
            const row = executeSqliteQueryTakeFirstSync(
              snapshot,
              getSessionKysely(snapshot)
                .selectFrom("session_nodes")
                .select(["session_key", "entry_json", "current_session_id", "updated_at"])
                .where("session_key", "=", sessionKey),
            );
            if (
              !sameEmbeddedAcpSource(
                row ? (parseSqliteSessionEntryRecord(row) ?? undefined) : undefined,
                entry,
              )
            ) {
              throw new Error(
                "Embedded ACP backup does not match the planned source; source retained.",
              );
            }
          }
        },
        beforePublish: assertSourceCurrent,
      });
      report.backups.push(backup.path);
      assertSourceCurrent();
      for (const [sessionKey, entry] of entries) {
        try {
          const meta = entry.acp;
          if (meta == null) {
            continue;
          }
          const owner = resolveSessionStorePathForAcp({
            cfg: params.cfg,
            env: params.env,
            sessionKey,
            agentId:
              parseAgentSessionKey(sessionKey)?.agentId ??
              (isPerAgentSessionStoreConfig(params.cfg.session?.store)
                ? target.agentId
                : undefined),
          });
          const ownerScope = resolveSqliteScope({
            agentId: owner.agentId,
            storePath: owner.storePath,
            sessionKey: owner.storeSessionKey,
            env: params.env,
          });
          if (
            owner.storeSessionKey !== sessionKey ||
            !isSameOpenClawAgentDatabasePath(
              resolveOpenClawAgentSqlitePath(toDatabaseOptions(ownerScope)),
              target.sqlitePath,
            )
          ) {
            throw new Error(
              "Embedded ACP session owner does not match its source store; source retained.",
            );
          }
          const resolved = resolveSqliteScope({ ...scope, sessionKey });
          const source = prepareLegacyAcpMigrationSource({
            sourcePath: target.sqlitePath,
            sourceSessionKey: sessionKey,
            sessionId: entry.sessionId,
            lifecycleRevision: entry.lifecycleRevision,
            meta,
            sourceEntry: {
              sessionId: entry.sessionId,
              sessionStartedAt: entry.sessionStartedAt,
              updatedAt: entry.updatedAt,
            },
          });
          const canonicalKey = buildAcpDatabaseSessionKey(sessionKey, owner.agentId);
          const normalized = bindAcpSessionMeta({
            sessionKey: canonicalKey,
            sessionId: entry.sessionId,
            lifecycleRevision: entry.lifecycleRevision,
            meta,
            updatedAt: entry.updatedAt,
          });
          const imported = withOpenClawAgentDatabaseReadOnly((agentDatabase) => {
            runOpenClawStateWriteTransaction(
              (shared) => {
                assertSourceCurrent();
                const current = readExactSessionEntryRowValidated(
                  agentDatabase,
                  resolved.sessionKey,
                )?.entry;
                if (!sameEmbeddedAcpSource(current, entry)) {
                  throw new Error(
                    "Embedded ACP source changed during Doctor repair; source retained.",
                  );
                }
                if (hasLegacyAcpMigrationCompletion(shared.db, source)) {
                  return;
                }
                const canonical = selectAcpSessionRow(shared.db, canonicalKey);
                if (
                  !canonical &&
                  selectAcpMigrationRowForStoreEntry(
                    shared.db,
                    sessionKey,
                    owner.agentId,
                    params.cfg,
                    entry,
                  )
                ) {
                  throw new Error(
                    "Unresolved legacy ACP aliases remain; embedded metadata retained.",
                  );
                }
                if (
                  canonical &&
                  (canonical.session_id !== (entry.lifecycleRevision ?? entry.sessionId) ||
                    canonical.updated_at !== normalized.updated_at ||
                    !isDeepStrictEqual(
                      rowToAcpSessionMeta(canonical),
                      rowToAcpSessionMeta(normalized),
                    ))
                ) {
                  throw new Error(
                    "Canonical ACP metadata conflicts with embedded metadata; both sources retained.",
                  );
                }
                assertSourceCurrent();
                if (!canonical) {
                  upsertAcpSessionMetaRow(shared.db, normalized);
                }
                recordLegacyAcpMigrationCompletion(shared.db, source, Date.now());
              },
              { env: params.env },
            );
          }, toDatabaseOptions(resolved));
          if (!imported.found) {
            throw new Error(`Embedded ACP owner became unavailable: ${imported.reason}`);
          }
          assertSourceCurrent();
          report.repaired += rewriteDoctorSessionEntries({
            scope,
            sessionKeys: [sessionKey],
            updateDeliveryProjection: false,
            transform(current) {
              assertSourceCurrent();
              if (!sameEmbeddedAcpSource(current, entry)) {
                throw new Error("Embedded ACP source changed after import; source retained.");
              }
              const { acp: _acp, ...next } = current;
              return next;
            },
          });
        } catch (error) {
          authority.assertCurrent();
          report.warnings.push(`${sessionKey}: ${String(error)}`);
        }
      }
    } catch (error) {
      params.authority?.assertCurrent();
      report.warnings.push(`${target.sqlitePath}: ${String(error)}`);
    }
  }
  return report;
}
