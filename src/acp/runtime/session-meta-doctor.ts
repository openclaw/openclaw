import { isDeepStrictEqual } from "node:util";
import { listAgentIds } from "../../agents/agent-scope-config.js";
import type { DoctorSqliteMaintenanceAuthority } from "../../commands/doctor-sqlite-maintenance-lock.js";
import { loadExactSessionEntryReadOnlyResult } from "../../config/sessions/session-accessor.sqlite-entry-availability.js";
import { readExactSessionEntryRowValidated } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { PluginDoctorRepairAuthority } from "../../infra/state-migrations.types.js";
import type {
  PluginDoctorAcpSessionClaim,
  PluginDoctorStateMigrationContext,
} from "../../plugins/doctor-contract-module.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  openExistingOpenClawStateDatabaseReadOnly,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import {
  acpSessionRowMatchesEntry,
  buildAcpDatabaseSessionKey,
  getAcpSessionKysely,
  parseAcpDatabaseSessionKeyCandidates,
  resolveLegacyFreeAcpSessionKey,
  selectAcpSessionRow,
  selectLegacyFreeAcpSessionRows,
  upsertAcpSessionMetaRow,
  type AcpSessionRow,
} from "./session-meta-keys.js";
import { rowToAcpSessionMeta } from "./session-meta-readonly.js";
import { resolveSessionStorePathForAcp } from "./session-meta-store.js";

type DoctorAcpScope = { config: OpenClawConfig; env: NodeJS.ProcessEnv; pluginId: string };

export type AcpSessionKeyRepairReport = {
  found: number;
  repaired: number;
  scannedRows: number;
  warnings: string[];
};

function sameAcpSessionPayload(left: AcpSessionRow, right: AcpSessionRow): boolean {
  return isDeepStrictEqual({ ...left, session_key: right.session_key }, { ...right });
}

/** Rekey existing raw ACP metadata only under Doctor's offline maintenance owner. */
export async function repairAcpSessionMetaKeysForDoctor(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  apply: boolean;
  authority?: DoctorSqliteMaintenanceAuthority;
}): Promise<AcpSessionKeyRepairReport> {
  const result: AcpSessionKeyRepairReport = {
    found: 0,
    repaired: 0,
    scannedRows: 0,
    warnings: [],
  };
  if (params.apply && !params.authority) {
    throw new Error("ACP key repair requires Doctor SQLite maintenance authority.");
  }
  params.authority?.assertCurrent();
  const database = await openExistingOpenClawStateDatabaseReadOnly({ env: params.env });
  if (!database) {
    return result;
  }
  let rows: AcpSessionRow[];
  try {
    params.authority?.assertCurrent();
    rows = executeSqliteQuerySync(
      database.db,
      getAcpSessionKysely(database.db).selectFrom("acp_sessions").selectAll(),
    ).rows;
  } finally {
    database.walMaintenance.close();
  }
  result.scannedRows = rows.length;
  const keys = new Set(
    rows.flatMap((row) => {
      const key = resolveLegacyFreeAcpSessionKey(row.session_key);
      return key ? [key] : [];
    }),
  );
  for (const sessionKey of keys) {
    try {
      const owner = resolveSessionStorePathForAcp({
        cfg: params.cfg,
        env: params.env,
        sessionKey,
      });
      const scope = {
        agentId: owner.agentId,
        storePath: owner.storePath,
        sessionKey: owner.storeSessionKey,
        env: params.env,
      };
      const resolved = resolveSqliteScope(scope);
      const stored = loadExactSessionEntryReadOnlyResult(scope);
      if (!stored.found || !stored.value) {
        throw new Error(`ACP session binding is ${stored.found ? "absent" : stored.reason}`);
      }
      const entry = stored.value.entry;
      const binding = {
        sessionId: entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision,
        sessionStartedAt: entry.sessionStartedAt,
      };
      const aliases = rows
        .filter((row) => resolveLegacyFreeAcpSessionKey(row.session_key) === sessionKey)
        .toSorted(
          (a, b) =>
            b.last_activity_at - a.last_activity_at ||
            (a.session_key < b.session_key ? -1 : a.session_key > b.session_key ? 1 : 0),
        );
      const matching = aliases.filter((row) => acpSessionRowMatchesEntry(row, binding));
      const source = matching.find((row) => row.session_key === sessionKey) ?? matching[0];
      if (!source) {
        throw new Error("ACP metadata binding is stale");
      }
      const destinationKey = buildAcpDatabaseSessionKey(owner.storeSessionKey, owner.agentId);
      const destination = rows.find((row) => row.session_key === destinationKey);
      if (
        destination &&
        (!acpSessionRowMatchesEntry(destination, binding) ||
          !sameAcpSessionPayload(destination, source))
      ) {
        throw new Error("canonical ACP metadata conflicts with its raw alias");
      }
      const consumed = matching.filter((row) => sameAcpSessionPayload(row, source));
      result.found += consumed.length;
      if (matching.length !== aliases.length) {
        result.warnings.push(`${sessionKey}: stale ACP aliases retained.`);
      }
      if (consumed.length !== matching.length) {
        result.warnings.push(`${sessionKey}: ACP aliases with conflicting payloads retained.`);
      }
      if (!params.apply) {
        continue;
      }
      const authority = params.authority!;
      authority.assertCurrent();
      const repaired = withOpenClawAgentDatabaseReadOnly((agentDatabase) => {
        runOpenClawStateWriteTransaction(
          (shared) => {
            authority.assertCurrent();
            const currentOwner = resolveSessionStorePathForAcp({
              cfg: params.cfg,
              env: params.env,
              sessionKey,
            });
            const currentEntry = readExactSessionEntryRowValidated(
              agentDatabase,
              resolved.sessionKey,
            )?.entry;
            const currentBinding = currentEntry && {
              sessionId: currentEntry.sessionId,
              lifecycleRevision: currentEntry.lifecycleRevision,
              sessionStartedAt: currentEntry.sessionStartedAt,
            };
            const currentAliases =
              selectLegacyFreeAcpSessionRows(shared.db, [sessionKey]).get(sessionKey) ?? [];
            if (
              !isDeepStrictEqual(currentOwner, owner) ||
              !isDeepStrictEqual(currentBinding, binding) ||
              !isDeepStrictEqual(currentAliases, aliases) ||
              !isDeepStrictEqual(selectAcpSessionRow(shared.db, destinationKey), destination)
            ) {
              throw new Error(
                "ACP ownership or metadata changed during Doctor repair; source retained",
              );
            }
            authority.assertCurrent();
            if (!destination) {
              upsertAcpSessionMetaRow(shared.db, { ...source, session_key: destinationKey });
            }
            executeSqliteQuerySync(
              shared.db,
              getAcpSessionKysely(shared.db)
                .deleteFrom("acp_sessions")
                .where(
                  "session_key",
                  "in",
                  consumed.map((row) => row.session_key),
                ),
            );
            sessionChanges.emit(
              { agentId: owner.agentId, sessionKey: owner.storeSessionKey },
              shared.db,
            );
          },
          { env: params.env },
        );
      }, toDatabaseOptions(resolved));
      if (!repaired.found) {
        throw new Error(`ACP owner database became unavailable: ${repaired.reason}`);
      }
      result.repaired += consumed.length;
    } catch (error) {
      params.authority?.assertCurrent();
      result.warnings.push(`${sessionKey}: ${String(error)}`);
    }
  }
  return result;
}

// Canonical metadata plus a current binding proves free harness namespaces. Configured
// binding keys still belong to the roster, even when their metadata survives retirement.
function isRetiredClaimOwner(
  config: OpenClawConfig,
  target: { agentId: string; sessionKey: string },
): boolean {
  const parsed = parseAgentSessionKey(target.sessionKey);
  const freeAcp = parsed?.rest.startsWith("acp:") && !parsed.rest.startsWith("acp:binding:");
  return !listAgentIds(config).includes(target.agentId) && !freeAcp;
}

function readClaimBinding(
  scope: DoctorAcpScope,
  target: { agentId: string; sessionKey: string },
): PluginDoctorAcpSessionClaim["binding"] {
  const owner = resolveSessionStorePathForAcp({ cfg: scope.config, env: scope.env, ...target });
  if (isRetiredClaimOwner(scope.config, target)) {
    throw new Error(`retired ACP owner ${owner.agentId}`);
  }
  const resolved = resolveSqliteScope({ ...target, env: scope.env, storePath: owner.storePath });
  const result = loadExactSessionEntryReadOnlyResult({
    ...target,
    sessionKey: resolved.sessionKey,
    env: scope.env,
    storePath: owner.storePath,
  });
  if (!result.found || !result.value) {
    throw new Error(`ACP session binding is ${result.found ? "absent" : result.reason}`);
  }
  const { sessionId, lifecycleRevision, sessionStartedAt } = result.value.entry;
  return { sessionId, lifecycleRevision, sessionStartedAt };
}

export async function inspectAcpSessionClaimsForDoctor(
  scope: DoctorAcpScope,
): Promise<
  Awaited<ReturnType<NonNullable<PluginDoctorStateMigrationContext["inspectAcpSessionClaims"]>>>
> {
  const claims: PluginDoctorAcpSessionClaim[] = [];
  const incomplete: string[] = [];
  try {
    const database = await openExistingOpenClawStateDatabaseReadOnly({ env: scope.env });
    if (!database) {
      return { claims, incomplete };
    }
    try {
      const rows = executeSqliteQuerySync(
        database.db,
        getAcpSessionKysely(database.db)
          .selectFrom("acp_sessions")
          .selectAll()
          .where("backend", "=", scope.pluginId),
      ).rows;
      for (const row of rows) {
        try {
          const target = parseAcpDatabaseSessionKeyCandidates(row.session_key)[0];
          if (
            !target?.agentId ||
            buildAcpDatabaseSessionKey(target.storeSessionKey, target.agentId) !== row.session_key
          ) {
            throw new Error("ACP metadata key is not canonical");
          }
          const claimTarget = { agentId: target.agentId, sessionKey: target.storeSessionKey };
          const binding = readClaimBinding(scope, claimTarget);
          if (row.session_id == null || !acpSessionRowMatchesEntry(row, binding)) {
            throw new Error("ACP metadata binding is absent or stale");
          }
          const meta = rowToAcpSessionMeta(row);
          if (
            (row.identity_json && !meta.identity) ||
            (row.runtime_options_json && !meta.runtimeOptions)
          ) {
            throw new Error("ACP metadata JSON is unreadable");
          }
          claims.push({ ...claimTarget, binding, meta });
        } catch (error) {
          incomplete.push(`${row.session_key}: ${String(error)}`);
        }
      }
    } finally {
      database.walMaintenance.close();
    }
  } catch (error) {
    incomplete.push(String(error));
  }
  return { claims, incomplete };
}

export function updateAcpSessionIdentityForDoctor(
  scope: DoctorAcpScope,
  authority: PluginDoctorRepairAuthority,
  input: Parameters<NonNullable<PluginDoctorStateMigrationContext["updateAcpSessionIdentity"]>>[0],
): void {
  authority.assertCurrent();
  const { claim } = input;
  if (claim.meta.backend !== scope.pluginId || !claim.meta.identity) {
    throw new Error("ACP identity repair requires a matching backend claim and existing identity");
  }
  const key = buildAcpDatabaseSessionKey(claim.sessionKey, claim.agentId);
  const owner = resolveSessionStorePathForAcp({ cfg: scope.config, env: scope.env, ...claim });
  const resolved = resolveSqliteScope({ ...claim, env: scope.env, storePath: owner.storePath });
  const options = toDatabaseOptions(resolved);
  // Open the read handle before the commit section; the maintenance owner excludes
  // writers while the transaction rereads the exact entry binding and ACP row.
  const updated = withOpenClawAgentDatabaseReadOnly((agentDatabase) => {
    runOpenClawStateWriteTransaction(
      (database) => {
        authority.assertOwnedInTransaction(database.db);
        const row = selectAcpSessionRow(database.db, key);
        const entry = readExactSessionEntryRowValidated(agentDatabase, resolved.sessionKey)?.entry;
        const binding = entry && {
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision,
          sessionStartedAt: entry.sessionStartedAt,
        };
        if (
          isRetiredClaimOwner(scope.config, claim) ||
          !row ||
          !isDeepStrictEqual(rowToAcpSessionMeta(row), claim.meta) ||
          !isDeepStrictEqual(binding, claim.binding) ||
          !acpSessionRowMatchesEntry(row, claim.binding)
        ) {
          throw new Error(
            "ACP ownership or metadata changed during Doctor repair; source retained",
          );
        }
        executeSqliteQuerySync(
          database.db,
          getAcpSessionKysely(database.db)
            .updateTable("acp_sessions")
            .set({
              runtime_session_name: input.runtimeSessionName,
              identity_json: JSON.stringify({
                ...claim.meta.identity,
                acpxRecordId: input.acpxRecordId,
              }),
            })
            .where("session_key", "=", key),
        );
        sessionChanges.emit({ agentId: claim.agentId, sessionKey: claim.sessionKey }, database.db);
      },
      { env: scope.env },
    );
  }, options);
  if (!updated.found) {
    throw new Error(`ACP owner database became unavailable: ${updated.reason}`);
  }
}
