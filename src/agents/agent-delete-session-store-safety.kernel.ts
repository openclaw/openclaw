import type { DatabaseSync } from "node:sqlite";
import { resolveSessionStoreCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { inspectOpenClawAgentDatabaseOwner } from "../state/openclaw-agent-db-lifecycle.js";
import { readRegisteredAgentDatabaseRows } from "../state/openclaw-agent-db-registry.read.js";
import { assertAgentSessionStoreDeletionTargetsCurrent } from "./agent-delete-session-store-safety.targets.js";
import type {
  AgentDeletionSessionStoreAbsentReadOperations,
  AgentDeletionSessionStoreReadOperations,
  AgentDeletionSessionStoreTargets,
} from "./agent-delete-session-store-safety.worker-contract.js";
import { listAgentIds } from "./agent-scope-config.js";

/** The caller owns the current shared-state read or write transaction. */
export function findAgentSessionStoreDeletionBlocker(
  database: { db: DatabaseSync; path: string } | undefined,
  cfg: OpenClawConfig,
  agentId: string,
  env?: NodeJS.ProcessEnv,
  targets?: AgentDeletionSessionStoreTargets,
): string | undefined {
  if (!cfg.session?.store?.trim()) {
    return undefined;
  }
  const id = normalizeAgentId(agentId);
  const defaultAgentId = resolveSessionStoreCompatibilityAgentId(cfg);
  if (targets) {
    assertAgentSessionStoreDeletionTargetsCurrent(targets);
  }
  const registeredDatabases = database
    ? readRegisteredAgentDatabaseRows(database.db, database.path, false)
    : [];
  for (const survivorId of listAgentIds(cfg)) {
    if (normalizeAgentId(survivorId) === id) {
      continue;
    }
    const storePath = resolveSessionStorePathCore(cfg.session.store, { agentId: survivorId, env });
    const target = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: survivorId,
      defaultAgentId,
      env,
      registeredDatabases,
    });
    const owner = inspectOpenClawAgentDatabaseOwner(target.path);
    if (owner.status === "owned" && owner.agentId === id) {
      if (targets) {
        assertAgentSessionStoreDeletionTargetsCurrent(targets);
      }
      return survivorId;
    }
  }
  if (targets) {
    assertAgentSessionStoreDeletionTargetsCurrent(targets);
  }
  return undefined;
}

export const agentDeletionSessionStoreReadOperations = {
  "agentDeletion.sessionStoreBlocker": (
    input: AgentDeletionSessionStoreReadOperations["agentDeletion.sessionStoreBlocker"]["input"],
    db: DatabaseSync,
  ): AgentDeletionSessionStoreReadOperations["agentDeletion.sessionStoreBlocker"]["output"] => ({
    type: "agentDeletion.sessionStoreBlocker",
    blocker: findAgentSessionStoreDeletionBlocker(
      { db, path: input.databasePath },
      input.config,
      input.agentId,
      input.env,
      input.targets,
    ),
  }),
};

export const agentDeletionSessionStoreAbsentReadOperations = {
  "agentRetirement.sessionStoreBlocker": (
    input: AgentDeletionSessionStoreAbsentReadOperations["agentRetirement.sessionStoreBlocker"]["input"],
  ): AgentDeletionSessionStoreAbsentReadOperations["agentRetirement.sessionStoreBlocker"]["output"] => ({
    blocker: findAgentSessionStoreDeletionBlocker(
      undefined,
      input.config,
      input.agentId,
      input.env,
      input.targets,
    ),
  }),
};
