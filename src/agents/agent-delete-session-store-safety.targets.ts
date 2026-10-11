import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveSessionStoreCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { listSqliteTargetCandidatePathsForSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { expandHomePrefix, resolveRequiredHomeDir, resolveUserPath } from "../infra/home-dir.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type {
  AgentDeletionSessionStoreSafetyInput,
  AgentDeletionSessionStoreTargets,
} from "./agent-delete-session-store-safety.worker-contract.js";
import { listAgentIds } from "./agent-scope-config.js";

function captureCandidates(stores: readonly string[]) {
  return [...new Set(stores.flatMap(listSqliteTargetCandidatePathsForSessionStorePath))]
    .toSorted()
    .map((pathname) => ({ path: pathname, identity: readDatabasePathIdentitySync(pathname) }));
}

/** Retain lexical families, physical aliases, and absences before discovery yields. */
export function prepareAgentSessionStoreDeletionSafety(
  cfg: OpenClawConfig,
  agentId: string,
  environment: NodeJS.ProcessEnv,
): AgentDeletionSessionStoreSafetyInput {
  const id = normalizeAgentId(agentId);
  const env = cloneEnvWithPlatformSemantics(environment);
  const config = structuredClone(cfg);
  const store = cfg.session?.store;
  if (store?.trim()) {
    config.agents = {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        sessionStore: { agentId: resolveSessionStoreCompatibilityAgentId(cfg) },
      },
    };
    config.session = {
      ...config.session,
      store: path.resolve(
        resolveUserPath("."),
        store.startsWith("~")
          ? expandHomePrefix(store, { home: resolveRequiredHomeDir(env), env })
          : store,
      ),
    };
  }
  const stores = store?.trim()
    ? listAgentIds(config)
        .filter((survivor) => normalizeAgentId(survivor) !== id)
        .map((survivor) =>
          resolveSessionStorePathCore(config.session?.store, { agentId: survivor, env }),
        )
    : [];
  return { config, agentId: id, env, targets: { stores, candidates: captureCandidates(stores) } };
}

export function assertAgentSessionStoreDeletionTargetsCurrent(
  targets: AgentDeletionSessionStoreTargets,
): void {
  if (!isDeepStrictEqual(captureCandidates(targets.stores), targets.candidates)) {
    throw new Error("Agent session database changed during deletion planning.");
  }
}
