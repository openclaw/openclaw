/** Reads reference names before service-env cleanup, without activating credentials. */
import nodePath from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Result } from "@openclaw/normalization-core/result";
import { collectEnvSecretRefIds } from "../../config/resolution-facts.js";
import { parseSecretRef } from "../../config/types.secrets.js";
import { isDeletedAgentDatabasePath } from "../../infra/agent-database-readers.js";
import { SqliteSnapshotCleanupError } from "../../infra/sqlite-readonly-location-cleanup.js";
import { prepareSqliteReadOnlyLocationSync } from "../../infra/sqlite-snapshot-source.js";
import { withArtifactPreservingStateReads } from "../../state/openclaw-state-db-readonly.js";
import { inspectSharedAuthStoreDatabaseTarget } from "./path-resolve.js";
import { readAuthProfileRowsReadOnly } from "./sqlite-json.js";
import { isMissingDatabasePath } from "./sqlite-read-pool.js";
import { inspectAuthProfileJsonCellReadOnly, resolveAuthProfileDatabasePath } from "./sqlite.js";
import { AuthProfileStoreUnreadableError } from "./store-unreadable-error.js";

export function collectAuthProfileEnvSecretRefIds(params: {
  agentDirs: readonly string[];
  env: NodeJS.ProcessEnv;
}): Set<string> {
  return withArtifactPreservingStateReads(() => {
    const shared = inspectSharedAuthStoreDatabaseTarget(params.env);
    const targets = new Map(
      params.agentDirs.map((agentDir) => {
        const path = resolveAuthProfileDatabasePath(agentDir);
        return [path, { kind: "agent" as const, path, env: params.env }];
      }),
    );
    const ids = new Set<string>();
    const inspections = [
      ...[...targets.values()].filter((target) => target.path !== shared.path),
      shared,
    ];
    for (const target of inspections) {
      if (isDeletedAgentDatabasePath(target.path) || isMissingDatabasePath(target.path)) {
        continue;
      }
      const inspection =
        target.kind === "agent"
          ? (() => {
              // Even readonly SQLite opens can create or change a source's WAL/SHM.
              const source = prepareSqliteReadOnlyLocationSync(target.path);
              let result: Result<ReturnType<typeof readAuthProfileRowsReadOnly>["store"], unknown>;
              try {
                result = {
                  ok: true,
                  value: readAuthProfileRowsReadOnly(
                    source.location,
                    source.cleanupRoot ?? nodePath.dirname(source.location),
                  ).store,
                };
              } catch (error) {
                result = { ok: false, error };
              }
              if (!source.cleanup()) {
                throw new SqliteSnapshotCleanupError(
                  `Auth profile snapshot cleanup failed: ${source.cleanupRoot ?? source.location}`,
                  result.ok ? undefined : { cause: result.error },
                );
              }
              if (!result.ok) {
                throw result.error;
              }
              return result.value;
            })()
          : inspectAuthProfileJsonCellReadOnly(target, "store");
      if (inspection.status === "missing") {
        continue;
      }
      if (
        inspection.status === "unreadable" ||
        !isRecord(inspection.raw) ||
        !isRecord(inspection.raw.profiles)
      ) {
        // An unreadable source cannot prove that an inherited credential is stale.
        throw new AuthProfileStoreUnreadableError(target.path);
      }
      for (const profile of Object.values(inspection.raw.profiles)) {
        if (!isRecord(profile) || (profile.type !== "api_key" && profile.type !== "token")) {
          continue;
        }
        const value =
          profile.type === "api_key"
            ? (parseSecretRef(profile.keyRef) ?? profile.key)
            : (parseSecretRef(profile.tokenRef) ?? profile.token);
        for (const id of collectEnvSecretRefIds(value)) {
          ids.add(id);
        }
      }
    }
    return ids;
  });
}
