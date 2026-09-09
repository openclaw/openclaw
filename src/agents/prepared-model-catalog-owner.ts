import { normalizeAgentId } from "../routing/session-key.js";
import { listAgentIds, resolveAgentDir, resolveAgentWorkspaceDir } from "./agent-scope.js";
import type {
  PublishedModelCatalogOwnerCandidate,
  ResolvedPublishedModelCatalogOwner,
} from "./prepared-model-catalog.types.js";
import { getPreparedModelRuntimeAuthStore } from "./prepared-model-runtime-auth.js";
import { resolveRouterSafePreparedRuntimePaths } from "./router-safe-prepared-runtime-paths.js";

class PublishedModelCatalogOwnerResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishedModelCatalogOwnerResolutionError";
  }
}

export function resolvePublishedModelCatalogOwner(
  snapshot: PublishedModelCatalogOwnerCandidate,
): ResolvedPublishedModelCatalogOwner {
  const configuredAgentIds = listAgentIds(snapshot.config);
  const directoryAgentIds = configuredAgentIds.filter(
    (candidate) => resolveAgentDir(snapshot.config, candidate) === snapshot.agentDir,
  );
  const routerSafeAgentIds = configuredAgentIds.filter((candidate) =>
    publishedOwnerMatchesConfiguredAgent(snapshot, candidate),
  );
  const agentId = snapshot.agentId
    ? resolvePublishedOwnerAgentIdByIdentity(snapshot, configuredAgentIds)
    : directoryAgentIds.length === 1
      ? directoryAgentIds[0]
      : routerSafeAgentIds.length === 1
        ? routerSafeAgentIds[0]
        : undefined;
  if (!agentId || !publishedOwnerMatchesConfiguredAgent(snapshot, agentId)) {
    throw new PublishedModelCatalogOwnerResolutionError(
      `published model catalog owner did not identify one configured agent (${snapshot.agentDir})`,
    );
  }
  const routerSafePaths = resolvePublishedOwnerRouterSafePaths(snapshot, agentId);
  const workspaceDir =
    snapshot.workspaceDir ??
    routerSafePaths?.workspaceDir ??
    resolveAgentWorkspaceDir(snapshot.config, agentId);
  if (!workspaceDir) {
    throw new PublishedModelCatalogOwnerResolutionError(
      `published model catalog owner did not identify a workspace (${agentId})`,
    );
  }
  const authStore = snapshot.authStore ?? getPreparedModelRuntimeAuthStore(snapshot);
  if (!authStore) {
    throw new PublishedModelCatalogOwnerResolutionError(
      `published model catalog owner is missing prepared auth state (${agentId})`,
    );
  }
  return Object.freeze({
    agentId,
    agentDir: snapshot.agentDir,
    workspaceDir,
    config: snapshot.config,
    authModes: snapshot.authModes,
    authStore,
    metadataSnapshot: snapshot.metadataSnapshot,
    modelCatalog: snapshot.modelCatalog,
  });
}

function resolvePublishedOwnerAgentIdByIdentity(
  snapshot: PublishedModelCatalogOwnerCandidate,
  configuredAgentIds: string[],
): string | undefined {
  if (!snapshot.agentId) {
    return undefined;
  }
  const requested = normalizeAgentId(snapshot.agentId);
  const matches = configuredAgentIds.filter(
    (candidate) => normalizeAgentId(candidate) === requested,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function resolvePublishedOwnerRouterSafePaths(
  snapshot: PublishedModelCatalogOwnerCandidate,
  agentId: string,
) {
  return resolveRouterSafePreparedRuntimePaths({
    agentId,
    agentDir: resolveAgentDir(snapshot.config, agentId),
    workspaceDir: resolveAgentWorkspaceDir(snapshot.config, agentId),
    source: "published",
    failClosed: false,
  });
}

function publishedOwnerMatchesConfiguredAgent(
  snapshot: PublishedModelCatalogOwnerCandidate,
  agentId: string,
): boolean {
  const configuredAgentDir = resolveAgentDir(snapshot.config, agentId);
  if (configuredAgentDir === snapshot.agentDir) {
    return true;
  }
  const routerSafePaths = resolvePublishedOwnerRouterSafePaths(snapshot, agentId);
  if (!routerSafePaths || routerSafePaths.agentDir !== snapshot.agentDir) {
    return false;
  }
  return !snapshot.workspaceDir || routerSafePaths.workspaceDir === snapshot.workspaceDir;
}

export function publishedModelCatalogOwnerMatchesAgent(
  owner: Pick<ResolvedPublishedModelCatalogOwner, "agentId">,
  agentId: string,
): boolean {
  return owner.agentId === normalizeAgentId(agentId);
}
