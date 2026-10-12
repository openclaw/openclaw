import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAbortError, racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { withAgentRosterFactsBatch } from "./agent-scope-config.js";
import { assertPreparedModelRuntimeAdmissionCanWait } from "./prepared-model-runtime-admission.js";
import { listConfiguredOwnerInputs } from "./prepared-model-runtime.configured.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import { retirePreparedModelRuntimeGeneration } from "./prepared-model-runtime.lifecycle.js";
import {
  advancePreparedModelRuntimeOwnerConfig,
  normalizePreparedModelRuntimeInput,
  ownerKey,
  resolveConfiguredOwner,
} from "./prepared-model-runtime.owner.js";
import { releasePreparedPluginPublication } from "./prepared-model-runtime.plugin-lifetime.js";
import type {
  PreparedModelCatalogInventory,
  PreparedModelRuntimeInput,
  PreparedModelRuntimeOwner,
  PreparedModelRuntimeRefreshOptions,
  PreparedModelRuntimeReplacement,
} from "./prepared-model-runtime.types.js";

const CATALOG_RECOVERY_DEMAND_COOLDOWN_MS = 5_000;
const log = createSubsystemLogger("agents/prepared-model-runtime");

export function refreshCommittedProviderCatalogs(
  owners: Iterable<PreparedModelRuntimeOwner>,
): void {
  for (const owner of owners) {
    if (owner.provenance !== "configured" || owner.pending || owner.needsRefresh) {
      continue;
    }
    owner.catalogRecovery = undefined;
    void owner.snapshot?.loadFullModelCatalog?.({ changedOnly: true }).catch((error: unknown) => {
      if (!(error instanceof PreparedModelRuntimePublicationSupersededError)) {
        log.warn(`provider catalog refresh failed: ${formatErrorMessage(error)}`);
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
      retirePreparedModelRuntimeGeneration(owner);
      retiredPublications.push(owner);
      continue;
    }
    owner.generation += 1;
    retirePreparedModelRuntimeGeneration(owner);
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

/** Includes unfinished or changed owners without replacing unrelated prepared generations. */
export function resolveSafeRefreshAgentIds(
  config: OpenClawConfig,
  options: PreparedModelRuntimeRefreshOptions,
  owners: Map<string, PreparedModelRuntimeOwner>,
): ReadonlySet<string> | undefined {
  if (!options.agentIds) {
    return undefined;
  }
  const agentIds = new Set(options.agentIds);
  const inputs = new Map(
    listConfiguredRefreshInputs(config, options, owners).flatMap((input) =>
      input.agentId ? [[input.agentId, input] as const] : [],
    ),
  );
  for (const owner of owners.values()) {
    if (owner.provenance !== "configured" || !owner.input.agentId) {
      continue;
    }
    const input = inputs.get(owner.input.agentId);
    inputs.delete(owner.input.agentId);
    if (
      !input ||
      !owner.snapshot ||
      owner.needsRefresh ||
      owner.catalogMode !== (options.catalogMode ?? "live") ||
      (options.pluginMetadataSnapshot &&
        owner.snapshot.metadataSnapshot !== options.pluginMetadataSnapshot) ||
      ownerKey({ ...owner.input, config: input.config }) !== ownerKey(input)
    ) {
      agentIds.add(owner.input.agentId);
    }
  }
  for (const agentId of inputs.keys()) {
    agentIds.add(agentId);
  }
  return agentIds;
}

/** Recovery operations share configured owners and the lifecycle's existing publication barrier. */
export function createPreparedModelRuntimeRecovery(host: {
  owners: Map<string, PreparedModelRuntimeOwner>;
  canRecover: () => boolean;
  getReplacement: () => PreparedModelRuntimeReplacement | undefined;
  getAdmissionReplacement: () => PreparedModelRuntimeReplacement | undefined;
  captureLifetime: () => () => void;
  publish: (
    config: OpenClawConfig | (() => OpenClawConfig | Promise<OpenClawConfig>),
    options: PreparedModelRuntimeRefreshOptions,
  ) => Promise<void>;
}) {
  const { owners, publish } = host;
  function recoverPlugin(owner: PreparedModelRuntimeOwner): void {
    if (
      !host.canRecover() ||
      host.getReplacement() ||
      owner.provenance !== "configured" ||
      owner.pending ||
      owners.get(ownerKey(owner.input)) !== owner
    ) {
      return;
    }
    // The publication queue owns recovery, not the closing caller or its retired
    // cache. Install its barrier synchronously; serialized builds join prior cleanup.
    void runInDetachedAsyncContext(async () => {
      try {
        await publish(() => owner.input.config, {
          catalogMode: "static",
          allowGatewaySubagentBinding: true,
        });
      } catch (error) {
        if (!(error instanceof PreparedModelRuntimePublicationSupersededError)) {
          log.warn(`retired plugin generation refresh failed: ${formatErrorMessage(error)}`);
        }
      }
    });
  }

  async function recoverCatalog(
    borrowers: readonly { agentDir: string; isCurrent: () => boolean }[],
  ): Promise<void> {
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
    try {
      await publish(first.input.config, {
        catalogMode: "static",
        allowGatewaySubagentBinding: true,
        agentIds: new Set(
          affected.flatMap((owner) => (owner.input.agentId ? [owner.input.agentId] : [])),
        ),
        pluginMetadataSnapshot: first.snapshot.metadataSnapshot,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        !(error instanceof PreparedModelRuntimePublicationSupersededError)
      ) {
        const recovery = { error, scheduledAttempted: false, retryAfter: 0 };
        for (const owner of affected) {
          if (owners.get(ownerKey(owner.input)) === owner && owner.refreshError === error) {
            owner.catalogRecovery = recovery;
          }
        }
      }
      throw error;
    }
  }

  /** Rechecks only failed catalog-worker replacements, using the existing publication barrier. */
  async function ensureGatewayPreparedModelRuntimeReady({
    agentId,
    demand = "interactive",
    abortSignal,
  }: {
    agentId: string;
    demand?: "interactive" | "scheduled";
    abortSignal?: AbortSignal;
  }): Promise<void> {
    if (abortSignal?.aborted) {
      throw createAbortError("Prepared reply dispatch admission aborted", {
        cause: abortSignal.reason,
      });
    }
    if (!host.canRecover()) {
      return;
    }
    const owner = resolveConfiguredOwner(host.owners, { agentId, agentDir: ".", config: {} });
    const recovery = owner?.catalogRecovery;
    if (!owner || !recovery) {
      return;
    }
    const assertLifetime = host.captureLifetime();
    const replacement = host.getAdmissionReplacement();
    if (replacement && !replacement.degraded) {
      assertPreparedModelRuntimeAdmissionCanWait();
      const joinsRecovery = recovery.replacementGateId === replacement.gateId;
      // A publication for another scope must not spend this failure's scheduled opportunity.
      if (demand === "scheduled" && joinsRecovery) {
        recovery.scheduledAttempted = true;
      }
      await racePromiseWithAbortSignal(replacement.promise, abortSignal);
      assertLifetime();
      if (joinsRecovery) {
        return;
      }
      return await ensureGatewayPreparedModelRuntimeReady({ agentId, demand, abortSignal });
    }
    if (
      !owner.needsRefresh ||
      owner.refreshError !== recovery.error ||
      (demand === "scheduled" ? recovery.scheduledAttempted : Date.now() < recovery.retryAfter)
    ) {
      return;
    }
    assertPreparedModelRuntimeAdmissionCanWait(owner);
    if (demand === "scheduled") {
      recovery.scheduledAttempted = true;
    }
    const affected = [...host.owners.values()].filter(
      (candidate) => candidate.catalogRecovery === recovery,
    );
    const publication = host
      .publish(owner.input.config, {
        catalogMode: "static",
        allowGatewaySubagentBinding: true,
        agentIds: new Set(affected.flatMap((candidate) => candidate.input.agentId ?? [])),
        pluginMetadataSnapshot: owner.snapshot?.metadataSnapshot,
        // publish() synchronously fences this owner before a full refresh may replace it.
        // Keep the publication current across that expected owner replacement.
        isPublicationCurrent: host.canRecover,
      })
      .catch((error: unknown) => {
        if (
          error instanceof Error &&
          !(error instanceof PreparedModelRuntimePublicationSupersededError) &&
          host.owners.get(ownerKey(owner.input)) === owner &&
          owner.catalogRecovery === recovery &&
          owner.refreshError === error
        ) {
          recovery.error = error;
          recovery.retryAfter = Date.now() + CATALOG_RECOVERY_DEMAND_COOLDOWN_MS;
        }
        throw error;
      });
    recovery.replacementGateId = host.getReplacement()?.gateId;
    await racePromiseWithAbortSignal(publication, abortSignal);
    assertLifetime();
  }

  return {
    ensureReady: ensureGatewayPreparedModelRuntimeReady,
    recoverCatalog,
    recoverPlugin,
  };
}
