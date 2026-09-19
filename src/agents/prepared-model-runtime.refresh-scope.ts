import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { withAgentRosterFactsBatch } from "./agent-scope-config.js";
import { listConfiguredOwnerInputs } from "./prepared-model-runtime.configured.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import {
  advancePreparedModelRuntimeOwnerConfig,
  normalizePreparedModelRuntimeInput,
  ownerKey,
} from "./prepared-model-runtime.owner.js";
import { releasePreparedPluginPublication } from "./prepared-model-runtime.plugin-lifetime.js";
import type {
  PreparedModelCatalogInventory,
  PreparedModelRuntimeInput,
  PreparedModelRuntimeOwner,
  PreparedModelRuntimeRefreshOptions,
} from "./prepared-model-runtime.types.js";

const log = createSubsystemLogger("agents/prepared-model-runtime");

export function refreshCommittedProviderCatalogs(
  owners: Iterable<PreparedModelRuntimeOwner>,
): void {
  for (const owner of owners) {
    if (owner.provenance !== "configured" || owner.pending || owner.needsRefresh) {
      continue;
    }
    void owner.snapshot?.loadFullModelCatalog?.({ changedOnly: true }).catch((error: unknown) => {
      if (!(error instanceof PreparedModelRuntimePublicationSupersededError)) {
        log.warn(`provider catalog refresh failed: ${String(error)}`);
      }
    });
  }
}

/** Retains provider inventory across runtime selection; rebuilds check its source and auth. */
export function collectPreparedModelRuntimeInventories(
  owners: Iterable<PreparedModelRuntimeOwner>,
): Map<string, PreparedModelCatalogInventory> {
  const inventories = new Map<string, PreparedModelCatalogInventory>();
  for (const owner of owners) {
    if (owner.provenance === "configured" && owner.catalogInventory) {
      inventories.set(
        ownerKey({ ...owner.input, runtimePluginSelections: undefined }),
        owner.catalogInventory,
      );
    }
  }
  return inventories;
}

/** Whether a refresh scope must replace this owner rather than retain it. */
export function isPreparedModelRuntimeOwnerInRefreshScope(
  owner: PreparedModelRuntimeOwner,
  agentIds: ReadonlySet<string> | undefined,
): boolean {
  if (!agentIds) {
    return true;
  }
  // Standalone and read-only owners keep independent config identities, so only configured and
  // leased run owners participate in agent-scoped retention.
  if (owner.input.readOnly || (owner.provenance !== "configured" && owner.provenance !== "run")) {
    return true;
  }
  return !owner.input.agentId || agentIds.has(owner.input.agentId);
}

/** Builds configured inputs while preserving the startup-selected default workspace. */
export function listConfiguredRefreshInputs(
  config: OpenClawConfig,
  options: PreparedModelRuntimeRefreshOptions,
  owners: Map<string, PreparedModelRuntimeOwner>,
): PreparedModelRuntimeInput[] {
  const preservedWorkspaceByAgentDir = new Map<string, Map<string, string>>();
  for (const owner of owners.values()) {
    const { agentDir, agentId, preserveWorkspaceDirOnRefresh, workspaceDir } = owner.input;
    if (
      owner.provenance !== "configured" ||
      !agentId ||
      !preserveWorkspaceDirOnRefresh ||
      !workspaceDir
    ) {
      continue;
    }
    let workspacesByDir = preservedWorkspaceByAgentDir.get(agentId);
    if (!workspacesByDir) {
      workspacesByDir = new Map();
      preservedWorkspaceByAgentDir.set(agentId, workspacesByDir);
    }
    if (!workspacesByDir.has(agentDir)) {
      workspacesByDir.set(agentDir, workspaceDir);
    }
  }
  return withAgentRosterFactsBatch(config, () =>
    listConfiguredOwnerInputs(
      config,
      options.defaultWorkspaceDir,
      options.allowGatewaySubagentBinding,
      preservedWorkspaceByAgentDir,
    ).map(normalizePreparedModelRuntimeInput),
  );
}

/** Invalidates scoped owners and optionally advances retained owners to a new config stamp. */
export function updateOwnersForScopedRefresh(
  owners: Map<string, PreparedModelRuntimeOwner>,
  agentIds: ReadonlySet<string> | undefined,
  staleError: Error,
  options: {
    retainedConfig?: OpenClawConfig;
    retireStandalone?: boolean;
    clearPending?: boolean;
    resetPluginGeneration?: boolean;
  } = {},
): void {
  const retiredPublications: PreparedModelRuntimeOwner[] = [];
  for (const [key, owner] of owners) {
    if (!isPreparedModelRuntimeOwnerInRefreshScope(owner, agentIds)) {
      if (options.retainedConfig) {
        advancePreparedModelRuntimeOwnerConfig(owner, options.retainedConfig);
      }
      continue;
    }
    if (options.retireStandalone && owner.provenance === "standalone") {
      owner.generation += 1;
      owners.delete(key);
      retiredPublications.push(owner);
      continue;
    }
    owner.generation += 1;
    owner.needsRefresh = true;
    owner.refreshError = staleError;
    if (options.clearPending) {
      owner.pending = undefined;
    }
    if (options.resetPluginGeneration) {
      owner.pluginGeneration = undefined;
      retiredPublications.push(owner);
    }
  }
  // Fence the whole scope before disposal can reenter plugin code. Idle publications
  // must not hold the replacement drain; admitted leases retain their own generation.
  retiredPublications.forEach(releasePreparedPluginPublication);
}

/** Keeps a requested scope only when every retained owner has identical prepared dependencies. */
export function resolveSafeRefreshAgentIds(
  config: OpenClawConfig,
  options: PreparedModelRuntimeRefreshOptions,
  owners: Map<string, PreparedModelRuntimeOwner>,
): ReadonlySet<string> | undefined {
  const requested = options.agentIds;
  if (!requested) {
    return undefined;
  }
  const inputs = new Map(
    listConfiguredRefreshInputs(config, options, owners).flatMap((input) =>
      input.agentId ? [[input.agentId, input] as const] : [],
    ),
  );
  for (const owner of owners.values()) {
    if (
      owner.provenance !== "configured" ||
      !owner.input.agentId ||
      requested.has(owner.input.agentId)
    ) {
      continue;
    }
    const input = inputs.get(owner.input.agentId);
    if (
      !input ||
      !owner.snapshot ||
      owner.needsRefresh ||
      owner.catalogMode !== (options.catalogMode ?? "live") ||
      (options.pluginMetadataSnapshot &&
        owner.snapshot.metadataSnapshot !== options.pluginMetadataSnapshot) ||
      ownerKey({ ...owner.input, config: input.config }) !== ownerKey(input)
    ) {
      return undefined;
    }
  }
  return requested;
}

/** A failed shared catalog isolate retires its borrowers through the publication owner. */
export function createPreparedModelRuntimeCatalogRecovery(
  owners: ReadonlyMap<string, PreparedModelRuntimeOwner>,
  publish: (config: OpenClawConfig, options: PreparedModelRuntimeRefreshOptions) => Promise<void>,
) {
  return async (
    borrowers: readonly { agentDir: string; isCurrent: () => boolean }[],
  ): Promise<void> => {
    const failed = new Map(
      borrowers
        .filter((borrower) => borrower.isCurrent())
        .map((borrower) => [borrower.agentDir, borrower]),
    );
    const affected = [...owners.values()].filter(
      (owner) =>
        owner.provenance === "configured" &&
        !owner.needsRefresh &&
        !owner.pending &&
        owner.input.agentId &&
        owner.snapshot &&
        failed.get(owner.input.agentDir)?.isCurrent(),
    );
    const first = affected[0];
    if (!first?.snapshot) {
      return;
    }
    // Owner inputs include config-only advances that the failed catalog's captured plan does not.
    // The existing publication queue fences old snapshots and retains live service registrations.
    await publish(first.input.config, {
      catalogMode: "static",
      allowGatewaySubagentBinding: true,
      agentIds: new Set(
        affected.flatMap((owner) => (owner.input.agentId ? [owner.input.agentId] : [])),
      ),
      pluginMetadataSnapshot: first.snapshot.metadataSnapshot,
    });
  };
}
