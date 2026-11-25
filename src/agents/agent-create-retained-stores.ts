import { realpathSync, statSync } from "node:fs";
import {
  applyAgentConfig,
  findAgentEntryIndex,
  listAgentEntries,
} from "../commands/agents.config.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getStateDatabaseSchemaLease,
  hasActiveGatewayStateOwner,
} from "../infra/gateway-state-owner.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { HeldAgentDatabase } from "../state/agent-deletion-journal.types.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import type { createOpenClawAgentDatabasePathMatcher } from "../state/openclaw-agent-db.paths.js";
import { createAgentSchemaInspectionWorker } from "../state/openclaw-agent-schema-inspection-worker.js";
import type { OpenClawDatabaseSchemaPreflight } from "../state/openclaw-database-preflight.types.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { DuplicateAgentError } from "./agent-create-error.js";
import { normalizeAgentDirRegistryPath } from "./agent-dir-registry.js";
import { resolveAgentDir } from "./agent-scope.js";

export function selectedRecoveryPaths(
  config: OpenClawConfig,
  agentId: string,
  held: readonly HeldAgentDatabase[],
  samePath: ReturnType<typeof createOpenClawAgentDatabasePathMatcher>,
  explicitAgentDir?: string,
): string[] {
  if (!held.some((entry) => entry.agentId === agentId)) {
    return [];
  }
  const currentDir = resolveAgentDir(config, agentId);
  const changedDir =
    explicitAgentDir !== undefined &&
    normalizeAgentDirRegistryPath(explicitAgentDir) !== normalizeAgentDirRegistryPath(currentDir);
  if (changedDir && findAgentEntryIndex(listAgentEntries(config), agentId) >= 0) {
    return [];
  }
  const selectedDir = explicitAgentDir ?? currentDir;
  const targets = resolveConfiguredAgentDatabaseTargets(
    applyAgentConfig(config, { agentId, agentDir: selectedDir }),
    { env: process.env, registeredDatabases: held },
  );
  return held
    .filter(
      (entry) =>
        entry.agentId === agentId &&
        statSync(entry.path, { throwIfNoEntry: false })?.isFile() &&
        targets.some((target) => target.agentId === agentId && samePath(target.path, entry.path)),
    )
    .map((entry) => entry.path);
}

/** Explicit restoration prepares old stores under Doctor custody before they become live. */
export async function migrateRetainedAgentStores(params: {
  agentId: string;
  paths: readonly string[];
  allowRestore: boolean;
  assertCurrent: () => void;
}): Promise<void> {
  const env = process.env;
  const targets = [...new Set(params.paths)].filter((pathname) =>
    statSync(pathname, { throwIfNoEntry: false })?.isFile(),
  );
  if (targets.length > 0 && !params.allowRestore) {
    throw new DuplicateAgentError(
      `Agent ${params.agentId} has retained databases. Run openclaw agents add ${params.agentId} to restore the preserved store explicitly.`,
    );
  }
  const migrations: NonNullable<OpenClawDatabaseSchemaPreflight["pendingMigrations"]> = [];
  await using inspector = createAgentSchemaInspectionWorker();
  for (const pathname of targets) {
    params.assertCurrent();
    const inspection = await inspector.inspect({
      pathname,
      agentId: params.agentId,
      env,
      supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
      inspectOwnership: true,
      allowClosedWal: true,
    });
    if (
      !inspection ||
      inspection.failure ||
      inspection.reason ||
      inspection.agentSchemaMeta?.role !== "agent" ||
      inspection.agentSchemaMeta.agentId !== params.agentId ||
      inspection.agentSchemaMeta.schemaVersion !== inspection.version ||
      inspection.version <= 0 ||
      inspection.version > OPENCLAW_AGENT_SCHEMA_VERSION
    ) {
      throw new DuplicateAgentError(
        `Cannot restore agent "${params.agentId}": could not verify the preserved database ${pathname}. Run openclaw doctor --fix to inspect its ownership and schema.`,
      );
    }
    if (inspection.version < OPENCLAW_AGENT_SCHEMA_VERSION) {
      migrations.push({
        kind: "agent",
        path: pathname,
        agentId: params.agentId,
        foundVersion: inspection.version,
        supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
    }
  }
  if (migrations.length === 0) {
    return;
  }
  const statePath = resolveOpenClawStateSqlitePath(env);
  if (hasActiveGatewayStateOwner(statePath)) {
    throw new DuplicateAgentError(
      `Agent "${params.agentId}" needs a database schema migration before restoration. Stop the Gateway, then run openclaw agents add ${params.agentId} again; its held data is unchanged.`,
    );
  }
  const [
    { completeDoctorMigrationBackups },
    { prepareDoctorDatabaseMigrations },
    { withStateDatabaseSchemaMaintenanceAsync },
    { migrateOpenClawAgentDatabaseForMaintenance },
    { withAgentDatabaseMaintenanceLease },
    { createOpenClawDatabaseMaintenanceScope },
  ] = await Promise.all([
    import("../commands/doctor-migration-backup-artifacts.js"),
    import("../commands/doctor-schema-migrations.js"),
    import("../infra/state-database-maintenance.js"),
    import("../state/openclaw-agent-db-maintenance.js"),
    import("../state/openclaw-agent-db-maintenance-lease.js"),
    import("../state/openclaw-state-db-async-lifecycle.js"),
  ]);
  await withStateDatabaseSchemaMaintenanceAsync({ databasePath: statePath }, async () => {
    params.assertCurrent();
    const lease = getStateDatabaseSchemaLease(statePath)!;
    const maintenance = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent: () => lease.assertCurrent(),
      assertDatabaseAccess: lease.assertDatabaseAccess,
    });
    try {
      const result = await maintenance.run(() =>
        prepareDoctorDatabaseMigrations({
          env,
          pendingDatabasePaths: migrations.map(({ path }) => path),
          pendingMigrations: migrations,
          databasePaths: targets,
          agentDatabaseTargets: targets.map((pathname) => ({
            agentId: params.agentId,
            path: pathname,
            realPath: realpathSync.native(pathname),
            source: "deletion",
          })),
        }),
      );
      if (!result.versionMigrations?.length) {
        // Full-image backups leave undeclared version transitions to Doctor's maintenance owner.
        await maintenance.run(() =>
          withAgentDatabaseMaintenanceLease({ env, processBound: true }, async (owner) => {
            for (const migration of migrations) {
              await migrateOpenClawAgentDatabaseForMaintenance(
                { agentId: params.agentId, pathname: migration.path, env },
                owner,
              );
              result.changes.push(
                `Upgraded agent database schema in ${migration.path}: v${migration.foundVersion} -> v${migration.supportedVersion}.`,
              );
            }
            completeDoctorMigrationBackups(env, targets);
          }),
        );
      }
      const log = createSubsystemLogger("agents/restore");
      result.changes.forEach((change) => log.info(change));
      result.warnings.forEach((warning) => log.warn(warning));
      params.assertCurrent();
    } finally {
      await maintenance.close();
    }
  });
}
