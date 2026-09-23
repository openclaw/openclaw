import type { OpenClawConfig } from "../config/types.openclaw.js";
import { retirePreparedModelRuntimeGeneration } from "./prepared-model-runtime.lifecycle.js";
import {
  ownerKey,
  prepareModelRuntimeOwner,
  publishPreparedModelRuntimeOwnerBatch,
} from "./prepared-model-runtime.owner.js";
import { releasePreparedPluginPublication } from "./prepared-model-runtime.plugin-lifetime.js";
import {
  collectPreparedModelRuntimeInventories,
  isPreparedModelRuntimeOwnerInRefreshScope,
  listConfiguredRefreshInputs,
  updateOwnersForScopedRefresh,
} from "./prepared-model-runtime.refresh-scope.js";
import type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimeOwner,
  PreparedModelRuntimeRefreshOptions,
} from "./prepared-model-runtime.types.js";

/** Rebuilds active owners after config/plugin runtime publication. */
export async function refreshPreparedModelRuntimeSnapshotsNow(
  config: OpenClawConfig,
  options: PreparedModelRuntimeRefreshOptions,
  context: {
    owners: Map<string, PreparedModelRuntimeOwner>;
    agentBuildCompletions: Map<string, Promise<void>>;
    buildTimeoutMs: number;
    gatewayLifecycleActive: boolean;
    isPublicationCurrent: () => boolean;
    acquisitionSignal: AbortSignal;
    progress?: Parameters<typeof publishPreparedModelRuntimeOwnerBatch>[0]["progress"];
  },
): Promise<void> {
  const { owners, agentBuildCompletions, gatewayLifecycleActive, isPublicationCurrent, progress } =
    context;
  const catalogMode = options.catalogMode ?? "live";
  const staleError = new Error("prepared model runtime owner is stale after config publication");
  const inventories = collectPreparedModelRuntimeInventories(owners.values());
  updateOwnersForScopedRefresh(owners, options.agentIds, staleError, {
    retainedConfig: config,
  });
  const entries: Array<{ owner?: PreparedModelRuntimeOwner; input: PreparedModelRuntimeInput }> =
    [];
  const knownKeys = new Set<string>();
  for (const input of listConfiguredRefreshInputs(config, options, owners)) {
    if (options.agentIds && input.agentId && !options.agentIds.has(input.agentId)) {
      continue;
    }
    const key = ownerKey(input);
    if (knownKeys.has(key)) {
      continue;
    }
    knownKeys.add(key);
    const owner = owners.get(key);
    entries.push({ owner, input });
  }
  for (const [key, owner] of owners) {
    if (!isPreparedModelRuntimeOwnerInRefreshScope(owner, options.agentIds)) {
      continue;
    }
    if (!knownKeys.has(key) && (gatewayLifecycleActive || owner.provenance === "configured")) {
      owners.delete(key);
      retirePreparedModelRuntimeGeneration(owner);
      releasePreparedPluginPublication(owner);
    }
  }
  const candidates = entries.map(({ owner: existing, input }) => {
    // Dynamic and standalone owners have different lifetime contracts. A configured publication
    // must replace them so an older lease release cannot remove the committed generation.
    const owner = prepareModelRuntimeOwner(
      input,
      "configured",
      catalogMode,
      existing?.provenance === "configured" ? existing : undefined,
    );
    owner.catalogInventory = inventories.get(
      ownerKey({ ...input, runtimePluginSelections: undefined }),
    );
    return owner;
  });
  await publishPreparedModelRuntimeOwnerBatch({
    ownersToPublish: candidates,
    owners,
    agentBuildCompletions,
    buildTimeoutMs: progress ? undefined : context.buildTimeoutMs,
    isPublicationCurrent,
    // Config replacement is one transaction. Per-owner auth supersession may retire individual
    // candidates, while a newer config epoch stops every remaining build in this publication.
    isBuildCurrent: isPublicationCurrent,
    onBuildStats: options.onBuildStats,
    pluginMetadataSnapshot: options.pluginMetadataSnapshot,
    registerEntriesAfterBuildStart: true,
    progress,
    acquisitionSignal: context.acquisitionSignal,
  });
}
