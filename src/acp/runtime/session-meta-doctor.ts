import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AgentSelectionRequiredError, listAgentIds } from "../../agents/agent-scope-config.js";
import type { DoctorSqliteMaintenanceAuthority } from "../../commands/doctor-sqlite-maintenance-lock.js";
import { loadExactSessionEntryReadOnlyResult } from "../../config/sessions/session-accessor.sqlite-entry-availability.js";
import { readExactSessionEntryRowValidated } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { resolvePersistedSessionStoreOwner } from "../../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  listExistingAgentDatabaseTargets,
  type ExistingAgentDatabaseTarget,
} from "../../infra/session-sqlite-migration-readers.js";
import { createVerifiedSqliteSnapshot } from "../../infra/sqlite-snapshot.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
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
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { sanitizeOpenClawStateLeaseRows } from "../../state/openclaw-state-snapshot-sanitizer.js";
import { captureAcpSessionEntryBinding } from "./session-meta-entry.kernel.js";
import {
  acpSessionRowMatchesEntry,
  buildAcpDatabaseSessionKey,
  getAcpSessionKysely,
  parseAcpDatabaseSessionKey,
  selectAcpSessionRow,
  selectAcpSessionRows,
  upsertAcpSessionMetaRow,
} from "./session-meta-keys.js";
import { repairEmbeddedAcpSessionMetaForDoctor } from "./session-meta-migration-embedded.js";
import { legacyAcpSessionKeyCandidates } from "./session-meta-migration-keys.js";
import type { AcpSessionRow } from "./session-meta-read.types.js";
import { rowToAcpSessionMeta } from "./session-meta-readonly.js";
import { resolveSessionStorePathForAcp } from "./session-meta-store.js";

type DoctorAcpScope = { config: OpenClawConfig; env: NodeJS.ProcessEnv; pluginId: string };

export type AcpSessionKeyRepairReport = {
  found: number;
  repaired: number;
  scannedRows: number;
  warnings: string[];
  backups?: string[];
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
  targets?: readonly ExistingAgentDatabaseTarget[];
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
  const targets = params.targets ?? listExistingAgentDatabaseTargets(params.cfg, params.env);
  const sourcePath = resolveOpenClawStateSqlitePath(params.env);
  const sourceIdentity = readDatabasePathIdentitySync(sourcePath);
  const assertSourceCurrent = () => {
    params.authority?.assertCurrent();
    assertExistingDatabaseIdentity(sourcePath, sourceIdentity.key, sourceIdentity.birthtime);
  };
  const database = await openExistingOpenClawStateDatabaseReadOnly({ env: params.env });
  let rows: AcpSessionRow[] = [];
  if (database) {
    try {
      assertSourceCurrent();
      rows = selectAcpSessionRows(database.db);
    } finally {
      database.walMaintenance.close();
    }
    result.scannedRows = rows.length;
    const candidateAgentIds = [
      ...new Set([...listAgentIds(params.cfg), ...targets.map((target) => target.agentId)]),
    ];
    const groups = new Map<
      string,
      { sessionKey: string; agentId: string; aliases: AcpSessionRow[] }
    >();
    for (const row of rows) {
      const destinations = new Map<string, { sessionKey: string; agentId: string }>();
      let problem: unknown;
      let inspectionFailed = false;
      for (const identity of legacyAcpSessionKeyCandidates(row.session_key, candidateAgentIds)) {
        try {
          const owner = resolveSessionStorePathForAcp({
            cfg: params.cfg,
            env: params.env,
            sessionKey: identity.storeSessionKey,
            agentId: identity.agentId,
          });
          const stored = loadExactSessionEntryReadOnlyResult({
            agentId: owner.agentId,
            storePath: owner.storePath,
            sessionKey: owner.storeSessionKey,
            env: params.env,
          });
          if (!stored.found) {
            inspectionFailed ||= stored.reason !== "database-missing";
            problem = new Error(`ACP session binding is ${stored.reason}`);
            continue;
          }
          if (!stored.value) {
            problem = new Error("ACP session binding is absent");
            continue;
          }
          if (!acpSessionRowMatchesEntry(row, stored.value.entry)) {
            problem = new Error("ACP metadata binding is stale");
            continue;
          }
          const destinationKey = buildAcpDatabaseSessionKey(owner.storeSessionKey, owner.agentId);
          destinations.set(destinationKey, {
            sessionKey: owner.storeSessionKey,
            agentId: owner.agentId,
          });
        } catch (error) {
          inspectionFailed ||= !(error instanceof AgentSelectionRequiredError);
          problem = error;
        }
      }
      if (inspectionFailed) {
        result.warnings.push(
          `${row.session_key}: could not inspect every candidate session owner: ${formatErrorMessage(problem)}; source retained. Repair the named store before rerunning Doctor.`,
        );
        continue;
      }
      if (destinations.size > 1) {
        result.warnings.push(
          `${row.session_key}: multiple session owners match this legacy key; source retained.`,
        );
        continue;
      }
      const destination = destinations.entries().next().value;
      if (!destination) {
        result.warnings.push(
          `${row.session_key}: ${formatErrorMessage(problem ?? "No matching live session binding was found")}. Restore its owning session/config or resolve its ownership, then rerun Doctor; source retained.`,
        );
        continue;
      }
      const [destinationKey, owner] = destination;
      if (destinationKey !== row.session_key) {
        const group = groups.get(destinationKey) ?? { ...owner, aliases: [] };
        group.aliases.push(row);
        groups.set(destinationKey, group);
      }
    }
    for (const [destinationKey, group] of groups) {
      const { sessionKey, agentId } = group;
      try {
        const owner = resolveSessionStorePathForAcp({
          cfg: params.cfg,
          env: params.env,
          sessionKey,
          agentId,
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
        const binding = captureAcpSessionEntryBinding(stored.value.entry);
        const aliases = group.aliases.toSorted(
          (a, b) =>
            b.last_activity_at - a.last_activity_at ||
            (a.session_key < b.session_key ? -1 : a.session_key > b.session_key ? 1 : 0),
        );
        const matching = aliases.filter((row) => acpSessionRowMatchesEntry(row, binding));
        const source =
          matching.find((row) => row.session_key === `@agent:${agentId}:${sessionKey}`) ??
          matching.find((row) => row.session_key === sessionKey) ??
          matching[0];
        if (!source) {
          throw new Error("ACP metadata binding is stale");
        }
        const destination = rows.find((row) => row.session_key === destinationKey);
        if (
          destination &&
          (!acpSessionRowMatchesEntry(destination, binding) ||
            !sameAcpSessionPayload(destination, source))
        ) {
          throw new Error("stored ACP metadata conflicts with its raw alias");
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
        assertSourceCurrent();
        if (!result.backups?.length) {
          const backup = await createVerifiedSqliteSnapshot({
            sourcePath: database.path,
            targetPath: `${database.path}.pre-acp-key-migration-${randomUUID()}.bak`,
            preserveRowIds: true,
            transform: sanitizeOpenClawStateLeaseRows,
            validate: (snapshot) => {
              if (!isDeepStrictEqual(selectAcpSessionRows(snapshot), rows)) {
                throw new Error("ACP backup does not match the planned metadata; source retained.");
              }
            },
            beforePublish: assertSourceCurrent,
          });
          result.backups = [backup.path];
          assertSourceCurrent();
        }
        const repaired = withOpenClawAgentDatabaseReadOnly((agentDatabase) => {
          runOpenClawStateWriteTransaction(
            (shared) => {
              assertSourceCurrent();
              const currentOwner = resolveSessionStorePathForAcp({
                cfg: params.cfg,
                env: params.env,
                sessionKey,
                agentId,
              });
              const currentEntry = readExactSessionEntryRowValidated(
                agentDatabase,
                resolved.sessionKey,
              )?.entry;
              const currentBinding = currentEntry && captureAcpSessionEntryBinding(currentEntry);
              const currentAliases = aliases.map((alias) =>
                selectAcpSessionRow(shared.db, alias.session_key),
              );
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
              assertSourceCurrent();
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
  }
  const embedded = await repairEmbeddedAcpSessionMetaForDoctor({ ...params, targets });
  result.found += embedded.found;
  result.repaired += embedded.repaired;
  result.warnings.push(...embedded.warnings);
  if (embedded.backups.length) {
    result.backups = [...(result.backups ?? []), ...embedded.backups];
  }
  return result;
}

// Canonical metadata plus a current binding proves free harness namespaces. Configured
// binding keys still belong to the roster, even when their metadata survives retirement.
function isRetiredClaimOwner(
  config: OpenClawConfig,
  target: { agentId: string; sessionKey: string },
): boolean {
  const storeOwner = resolvePersistedSessionStoreOwner(config);
  if (storeOwner.kind === "retired" && storeOwner.agentId === target.agentId) {
    return true;
  }
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
  return captureAcpSessionEntryBinding(result.value.entry);
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
          const target = parseAcpDatabaseSessionKey(row.session_key);
          if (
            !target?.agentId ||
            buildAcpDatabaseSessionKey(target.storeSessionKey, target.agentId) !== row.session_key
          ) {
            throw new Error("ACP metadata key is not in the expected format");
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
        const binding = entry && captureAcpSessionEntryBinding(entry);
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
