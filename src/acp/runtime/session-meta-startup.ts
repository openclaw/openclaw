import { AgentSelectionRequiredError, listAgentIds } from "../../agents/agent-scope-config.js";
import { SessionStoreMigrationRequiredError } from "../../config/sessions/migration-required.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  getSessionKysely,
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { parseSqliteSessionEntryRecord } from "../../config/sessions/session-entry-json.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import {
  createOpenClawAgentDatabasePathMatcher,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import {
  acpSessionRowMatchesEntry,
  buildAcpDatabaseSessionKey,
  parseAcpDatabaseSessionKey,
} from "./session-meta-keys.js";
import { legacyAcpSessionKeyCandidates } from "./session-meta-migration-keys.js";
import { resolveSessionStorePathForAcp } from "./session-meta-store.js";

function migrationRequired(source: string): never {
  throw new SessionStoreMigrationRequiredError(
    `ACP metadata requires offline migration at ${source}. Stop the Gateway and run "openclaw doctor --fix" against the same state/config before starting OpenClaw.`,
  );
}

/** Initial boot covers all shared state; live readmission checks only its physical store. */
export async function assertAcpSessionKeysMigratedForStartup(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  admittedAgentIds: readonly string[],
  admittedDatabase: OpenClawAgentDatabaseOptions | undefined,
  assertCurrent?: () => void,
): Promise<void> {
  assertCurrent?.();
  const result = await executeExistingOpenClawStateRead({ env }, { type: "acpSessions.list" });
  assertCurrent?.();
  if (!result) {
    return;
  }
  if (!result.ok || result.type !== "acpSessions.list") {
    throw new Error("Could not inspect ACP metadata before session startup.");
  }
  const candidateAgentIds = [...new Set([...listAgentIds(cfg), ...admittedAgentIds])];
  const admittedPath = admittedDatabase
    ? resolveOpenClawAgentSqlitePath(admittedDatabase)
    : undefined;
  const matchesPath = createOpenClawAgentDatabasePathMatcher();
  const candidatePath = (agentId: string, storePath: string, sessionKey: string) =>
    resolveOpenClawAgentSqlitePath(
      toDatabaseOptions(resolveSqliteReadScope({ agentId, storePath, sessionKey, env })),
    );
  const ownsPath = (agentId: string, storePath: string, sessionKey: string) =>
    admittedPath === undefined ||
    matchesPath(candidatePath(agentId, storePath, sessionKey), admittedPath);
  for (const row of result.rows) {
    const identities = legacyAcpSessionKeyCandidates(row.session_key, candidateAgentIds);
    const hasRecordedOwner = identities.some((identity) => identity.ownerRecorded);
    const candidates: Array<{
      owner: ReturnType<typeof resolveSessionStorePathForAcp>;
      ownerRecorded: boolean;
      local: boolean;
    }> = [];
    for (const identity of identities) {
      let owner: ReturnType<typeof resolveSessionStorePathForAcp>;
      try {
        owner = resolveSessionStorePathForAcp({
          cfg,
          env,
          sessionKey: identity.storeSessionKey,
          agentId: identity.agentId,
        });
      } catch (error) {
        if (!(error instanceof AgentSelectionRequiredError)) {
          throw error;
        }
        const storePath = resolveSessionStorePathCore(cfg.session?.store, {
          agentId: identity.agentId,
          env,
        });
        if (identity.ownerRecorded && ownsPath(identity.agentId, storePath, "")) {
          migrationRequired(`unresolved shared ACP owner ${JSON.stringify(row.session_key)}`);
        }
        continue;
      }
      candidates.push({
        owner,
        ownerRecorded: identity.ownerRecorded,
        local: ownsPath(owner.agentId, owner.storePath, owner.storeSessionKey),
      });
    }
    if (!candidates.some((candidate) => candidate.local)) {
      continue;
    }
    const recorded = candidates.find((candidate) => candidate.local && candidate.ownerRecorded);
    if (recorded || (!hasRecordedOwner && admittedPath === undefined)) {
      const canonical = parseAcpDatabaseSessionKey(row.session_key);
      if (!canonical?.agentId) {
        migrationRequired(`shared ACP key ${JSON.stringify(row.session_key)}`);
      }
      if (
        recorded &&
        buildAcpDatabaseSessionKey(recorded.owner.storeSessionKey, recorded.owner.agentId) !==
          row.session_key
      ) {
        migrationRequired(`noncanonical inner ACP key ${JSON.stringify(row.session_key)}`);
      }
    }
    for (const candidate of candidates) {
      if (candidate.ownerRecorded || !candidate.local) {
        continue;
      }
      const { owner } = candidate;
      await withSessionEntryReadOnlyInWorker(
        {
          agentId: owner.agentId,
          storePath: owner.storePath,
          env,
          sessionKey: owner.storeSessionKey,
        },
        () => assertCurrent?.(),
        async (read) => {
          if (!read.ok) {
            migrationRequired(
              `unreadable literal-key candidate store ${JSON.stringify(owner.storePath)}`,
            );
          }
          if (read.value && acpSessionRowMatchesEntry(row, read.value)) {
            migrationRequired(`historical literal ACP key ${JSON.stringify(row.session_key)}`);
          }
        },
      );
      assertCurrent?.();
    }
  }
  if (!matchesPath.isCurrent()) {
    throw new Error("ACP session store ownership changed during startup; retry admission.");
  }
}

/** Boot admission only; ordinary reads never probe or normalize embedded metadata. */
export function assertEmbeddedAcpMetadataMigratedForStartup(
  options: OpenClawAgentDatabaseOptions,
): void {
  const inspected = withOpenClawAgentDatabaseReadOnly((database) => {
    const db = getSessionKysely(database.db);
    for (const row of iterateSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_nodes")
        .select(["session_key", "entry_json", "current_session_id", "updated_at"]),
    )) {
      if (parseSqliteSessionEntryRecord(row)?.acp != null) {
        return { session_key: row.session_key };
      }
    }
    return undefined;
  }, options);
  if (inspected.found && inspected.value) {
    migrationRequired(
      `agent ${JSON.stringify(options.agentId)} session ${JSON.stringify(inspected.value.session_key)}`,
    );
  }
}
