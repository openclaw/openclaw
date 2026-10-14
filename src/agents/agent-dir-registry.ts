/** Process-local reverse registry from prepared agent directories to agent ids. */
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { resolveIdentityPathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { observeOwnedDirectory } from "../infra/owned-directory-observation.js";
import { isPathInside } from "../infra/path-guards.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import { resolveUserPath } from "../utils.js";

// Process-local registry mapping resolved agent directories back to agent ids.
// It lets later runtime paths recover scope from an already-prepared agent dir.
const agentIdsByDir = new Map<string, Set<string>>();
const preparedPaths = resolveGlobalMap<string, { key: string; close(): void }>(
  Symbol.for("openclaw.agentDirPreparedPaths"),
  (paths) => {
    for (const prepared of paths.values()) {
      prepared.close();
    }
    paths.clear();
  },
  "shared-state",
);

function forgetPreparedPaths(key: string) {
  for (const [pathname, prepared] of preparedPaths) {
    if (prepared.key === key) {
      preparedPaths.delete(pathname);
      prepared.close();
    }
  }
}

function registryPath(agentDir: string, env?: NodeJS.ProcessEnv, registering = false): string {
  const pathname = path.resolve(resolveUserPath(agentDir, env));
  const cached = preparedPaths.get(pathname);
  if (cached) {
    return cached.key;
  }
  const key = normalizeAgentDirRegistryPath(pathname, env);
  if (!isMainThread || (!registering && !agentIdsByDir.has(key))) {
    return key;
  }
  const observations: Array<{ close(): void }> = [];
  const prepared = {
    key,
    close: () => observations.forEach((observation) => observation.close()),
  };
  preparedPaths.set(pathname, prepared);
  // Each lexical ancestor can be a symlink replaced independently of the leaf.
  for (let child = pathname; path.dirname(child) !== child; child = path.dirname(child)) {
    const basename = path.basename(child);
    observations.push(
      observeOwnedDirectory(
        path.dirname(child),
        (filename) => {
          if (filename === undefined || filename === basename) {
            if (resolveIdentityPathViaExistingAncestorSync(pathname) === key) {
              return;
            }
            preparedPaths.delete(pathname);
            prepared.close();
          }
        },
        { recoveryIntervalMs: 30_000 },
      ),
    );
  }
  // Fit the registered fleet plus this registration while bounding extra aliases.
  const capacity = Math.max(256, agentIdsByDir.size + 1);
  for (const [oldestPath, oldest] of preparedPaths) {
    if (preparedPaths.size <= capacity) {
      break;
    }
    preparedPaths.delete(oldestPath);
    oldest.close();
  }
  return key;
}

export function normalizeAgentDirRegistryPath(
  agentDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveIdentityPathViaExistingAncestorSync(resolveUserPath(agentDir, env));
}

/** Register a resolved agent directory for later reverse lookup. */
export function registerResolvedAgentDir(params: {
  agentId: string;
  agentDir: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const key = registryPath(params.agentDir, params.env, true);
  const agentIds = agentIdsByDir.get(key) ?? new Set<string>();
  const agentId = normalizeAgentId(params.agentId);
  if (agentIds.has(agentId)) {
    return false;
  }
  agentIds.add(agentId);
  agentIdsByDir.set(key, agentIds);
  return true;
}

/** Remove a reverse lookup only while it still belongs to the expected agent. */
export function unregisterResolvedAgentDir(params: {
  agentId: string;
  agentDir: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const key = normalizeAgentDirRegistryPath(params.agentDir, params.env);
  const agentIds = agentIdsByDir.get(key);
  if (!agentIds?.delete(normalizeAgentId(params.agentId))) {
    return false;
  }
  if (agentIds.size === 0) {
    agentIdsByDir.delete(key);
    forgetPreparedPaths(key);
  }
  return true;
}

/** Resolve the agent id previously registered for an agent directory. */
export function resolveRegisteredAgentIdForDir(
  agentDir: string,
  env?: NodeJS.ProcessEnv,
): string | undefined {
  const agentIds = agentIdsByDir.get(registryPath(agentDir, env));
  return agentIds?.size === 1 ? agentIds.values().next().value : undefined;
}

/** Whether a path overlaps a directory currently owned by another agent. */
export function isPathOwnedByAnotherRegisteredAgent(params: {
  agentId: string;
  pathname: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const pathname = normalizeAgentDirRegistryPath(params.pathname, params.env);
  const agentId = normalizeAgentId(params.agentId);
  for (const [registeredDir, ownerIds] of agentIdsByDir) {
    if (
      [...ownerIds].some((ownerId) => ownerId !== agentId) &&
      (registeredDir === pathname ||
        isPathInside(registeredDir, pathname) ||
        isPathInside(pathname, registeredDir))
    ) {
      return true;
    }
  }
  return false;
}
