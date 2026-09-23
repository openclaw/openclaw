/** Agent-run lease admission for lifecycle-owned prepared model runtimes. */
import { createAbortError, racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import { getPreparedModelRuntimeBorrowedSnapshot } from "./prepared-model-runtime-generation-scope.js";
import { capturePreparedModelRuntimeCatalog } from "./prepared-model-runtime.capture.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  PreparedModelRuntimePublicationSupersededError,
  ownerKey,
  normalizePreparedModelRuntimeInput,
  preparedModelRuntimeConfigsMatch,
  publishModelRuntimeSnapshot,
  rebindInputToCommittedConfiguredOwner,
  resolveConfiguredOwner,
  resolveConfiguredOwnerPublication,
  type PreparedModelRuntimeInput,
  type PreparedModelRuntimeLease,
  type PreparedModelRuntimeOwner,
  type PreparedModelRuntimeReplacement,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.owner.js";
import {
  preparedPluginGenerationReusesBase,
  preparedPluginGenerationSupportsSelections,
} from "./prepared-model-runtime.plugin-generation.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import {
  retirePreparedModelRuntimeOwnerIfUnused,
  type PreparedModelRuntimeOwnerRetention,
} from "./prepared-model-runtime.retention.js";
import type { PreparedModelRuntimeLeaseOptions } from "./prepared-model-runtime.types.js";

type PreparedModelRuntimeLeaseContext = {
  captureLifetime(): () => void;
  owners: Map<string, PreparedModelRuntimeOwner>;
  agentBuildCompletions: Map<string, Promise<void>>;
  retainedDirectRunOwners: PreparedModelRuntimeOwnerRetention;
  retainedGatewayRunOwners: PreparedModelRuntimeOwnerRetention;
  getBuildTimeoutMs(): number;
  getGatewayLifecycleActive(): boolean;
  getPendingReplacement(): PreparedModelRuntimeReplacement | undefined;
};

function createPreparedModelRuntimeAdmissionClaim(context: PreparedModelRuntimeLeaseContext) {
  let claimed: { key: string; owner: PreparedModelRuntimeOwner } | undefined;
  const release = () => {
    if (!claimed) {
      return;
    }
    const { key, owner } = claimed;
    claimed = undefined;
    owner.admissionCount = Math.max(0, (owner.admissionCount ?? 1) - 1);
    retirePreparedModelRuntimeOwnerIfUnused(
      context.owners,
      key,
      owner,
      context.retainedDirectRunOwners.has(key, owner) ||
        context.retainedGatewayRunOwners.has(key, owner),
    );
  };
  return {
    claim: (key: string, owner: PreparedModelRuntimeOwner) => {
      if (claimed?.key === key && claimed.owner === owner) {
        return;
      }
      release();
      if (
        (owner.provenance !== "run" && owner.provenance !== "ephemeral") ||
        context.owners.get(key) !== owner
      ) {
        return;
      }
      owner.admissionCount = (owner.admissionCount ?? 0) + 1;
      claimed = { key, owner };
    },
    release,
  };
}

export async function acquirePreparedModelRuntimeLeaseFromOwners(
  rawInput: PreparedModelRuntimeInput,
  provenance: "run" | "ephemeral",
  context: PreparedModelRuntimeLeaseContext,
  options: PreparedModelRuntimeLeaseOptions = {},
): Promise<PreparedModelRuntimeLease> {
  const assertLifetime = context.captureLifetime();
  const assertAdmission = () => {
    assertLifetime();
    if (options.abortSignal?.aborted) {
      throw createAbortError("Prepared model runtime lease admission aborted", {
        cause: options.abortSignal.reason,
      });
    }
  };
  const deriveSelections = options.deriveRuntimePluginSelections;
  // Caller choices belong to this invocation; only config-derived choices may change after a wait.
  const requestedSelections = deriveSelections
    ? structuredClone(rawInput.runtimePluginSelections ?? [])
    : [];
  let input = normalizePreparedModelRuntimeInput({
    ...rawInput,
    preserveWorkspaceDirOnRefresh:
      rawInput.preserveWorkspaceDirOnRefresh ?? rawInput.workspaceDir !== undefined,
  });
  let key = ownerKey(input);
  let owner: PreparedModelRuntimeOwner;
  let snapshot: PreparedModelRuntimeSnapshot;
  const admission = createPreparedModelRuntimeAdmissionClaim(context);
  let lastExternalPublication: Promise<unknown> | undefined;
  let previousAttempt: readonly unknown[] | undefined;
  let supersededPublication: PreparedModelRuntimePublicationSupersededError | undefined;
  for (;;) {
    admission.release();
    assertAdmission();
    // Replacement owns publication from synchronous staling through atomic generation commit.
    // Dynamic work arriving inside that window must retry after the new owners become visible.
    const replacement = context.getPendingReplacement();
    const currentOwner = context.owners.get(key);
    const attempt = [
      key,
      replacement,
      currentOwner,
      currentOwner?.generation,
      currentOwner?.snapshot,
      currentOwner?.pending,
      currentOwner?.needsRefresh,
      lastExternalPublication,
    ];
    if (previousAttempt?.every((value, index) => value === attempt[index])) {
      // Failed construction can retire its owner, hiding supersession from this checkpoint.
      throw (
        supersededPublication ??
        new PreparedModelRuntimeOwnerNotPublishedError(
          `prepared model runtime lease admission made no publication progress for ${input.agentDir}; retry the request`,
        )
      );
    }
    previousAttempt = attempt;
    supersededPublication = undefined;
    if (replacement) {
      lastExternalPublication = replacement.promise;
      await racePromiseWithAbortSignal(replacement.promise, options.abortSignal);
      if (context.getPendingReplacement()) {
        continue;
      }
      assertAdmission();
    }
    if (
      provenance === "run" &&
      !options.pluginGeneration &&
      (replacement || context.getGatewayLifecycleActive())
    ) {
      try {
        input = rebindInputToCommittedConfiguredOwner(context.owners, input);
      } catch (error) {
        if (replacement || !(error instanceof PreparedModelRuntimeOwnerNotPublishedError)) {
          throw error;
        }
        const existing = context.owners.get(ownerKey(input));
        const staleDynamicOwner =
          existing?.needsRefresh &&
          !existing.pending &&
          (existing.provenance === "run" || existing.provenance === "ephemeral");
        if (!existing || staleDynamicOwner) {
          const canActivateConfiglessSetup =
            input.agentId !== undefined && isReservedSystemAgentId(input.agentId);
          const configuredOwner = resolveConfiguredOwnerPublication(context.owners, input);
          if (configuredOwner.matches || !canActivateConfiglessSetup) {
            if (configuredOwner.pending) {
              lastExternalPublication = configuredOwner.pending;
              await racePromiseWithAbortSignal(configuredOwner.pending, options.abortSignal);
              continue;
            }
            throw error;
          }
          // Reserved setup may borrow the configless Gateway before its first owner exists.
        }
      }
    }
    // Recipes run after config admission. Never carry a derived owner into a later rebind.
    let pluginMetadataSnapshot = options.pluginMetadataSnapshot;
    if (deriveSelections) {
      pluginMetadataSnapshot =
        options.pluginGeneration?.pluginMetadataSnapshot ??
        pluginMetadataSnapshot ??
        resolvePluginMetadataSnapshot({
          config: input.config,
          env: input.env,
          workspaceDir: input.workspaceDir,
          allowWorkspaceScopedCurrent: true,
        });
      const metadataSnapshot = pluginMetadataSnapshot;
      input = withPluginMetadataSnapshotScope(
        metadataSnapshot,
        () => {
          const derived = deriveSelections({
            config: input.config,
            metadataSnapshot,
          });
          return normalizePreparedModelRuntimeInput({
            ...input,
            runtimePluginSelections: [...requestedSelections, ...derived],
          });
        },
        { trustConfigIdentity: true },
      );
    }
    key = ownerKey(input);
    if (provenance === "run" && context.getGatewayLifecycleActive() && options.pluginGeneration) {
      const configuredOwner = resolveConfiguredOwner(context.owners, input);
      if (configuredOwner?.pending) {
        lastExternalPublication = configuredOwner.pending;
        await racePromiseWithAbortSignal(
          configuredOwner.pending.catch(() => undefined),
          options.abortSignal,
        );
        continue;
      }
      if (
        configuredOwner &&
        (configuredOwner.needsRefresh ||
          configuredOwner.pluginGeneration !== options.pluginGeneration)
      ) {
        const borrowed = getPreparedModelRuntimeBorrowedSnapshot(options.pluginGeneration);
        if (
          !configuredOwner.needsRefresh &&
          borrowed &&
          borrowed.metadataSnapshot === options.pluginGeneration.pluginMetadataSnapshot &&
          preparedModelRuntimeConfigsMatch(borrowed.config, input.config) &&
          borrowed.agentId === input.agentId &&
          borrowed.agentDir === input.agentDir &&
          borrowed.inheritedAuthDir === input.inheritedAuthDir &&
          borrowed.workspaceDir === input.workspaceDir &&
          (!input.allowGatewaySubagentBinding || borrowed.allowGatewaySubagentBinding) &&
          !input.readOnly &&
          !input.loadRuntimePlugins &&
          !input.skipCredentials &&
          !input.env &&
          preparedPluginGenerationSupportsSelections(options.pluginGeneration, input)
        ) {
          // A turn may finish under its still-open parent lease after reload. Its historic
          // generation must never publish over the configured owner for newly admitted work.
          assertAdmission();
          return {
            snapshot: borrowed,
            pluginGeneration: options.pluginGeneration,
            [Symbol.asyncDispose]: retainPreparedPluginGeneration(options.pluginGeneration),
          };
        }
        throw new PreparedModelRuntimeOwnerNotPublishedError(
          `prepared model runtime plugin generation was superseded for ${input.agentDir}`,
        );
      }
    }
    if (
      provenance === "run" &&
      context.getGatewayLifecycleActive() &&
      options.catalogMode === "static" &&
      !options.pluginGeneration &&
      !options.pluginMetadataSnapshot &&
      !input.readOnly &&
      !input.loadRuntimePlugins &&
      !input.skipCredentials
    ) {
      const configuredOwner = resolveConfiguredOwner(context.owners, input);
      const configuredSnapshot = configuredOwner?.snapshot;
      const generation = configuredOwner?.pluginGeneration;
      if (
        configuredOwner &&
        configuredSnapshot &&
        generation &&
        !configuredOwner.pending &&
        !configuredOwner.needsRefresh &&
        !configuredOwner.refreshError &&
        configuredSnapshot.isCurrent() &&
        configuredSnapshot.config === input.config &&
        ownerKey({ ...configuredOwner.input, runtimePluginSelections: undefined }) ===
          ownerKey({ ...input, runtimePluginSelections: undefined }) &&
        (!pluginMetadataSnapshot || pluginMetadataSnapshot === generation.pluginMetadataSnapshot) &&
        preparedPluginGenerationSupportsSelections(generation, input)
      ) {
        // Covered selections share the configured generation; the lease retains it before yielding.
        owner = configuredOwner;
        snapshot = configuredSnapshot;
        break;
      }
    }
    const existing = context.owners.get(key);
    const staleDynamicOwner =
      existing?.needsRefresh &&
      !existing.pending &&
      (existing.provenance === "run" || existing.provenance === "ephemeral");
    // A static owner cannot satisfy explicit live discovery; publish a new exact generation.
    const ownerGenerationChanged =
      (options.pluginGeneration !== undefined &&
        !preparedPluginGenerationReusesBase(
          existing?.pending ? existing.pendingPluginGeneration : existing?.pluginGeneration,
          options.pluginGeneration,
        )) ||
      (options.catalogMode === "live" && existing?.catalogMode === "static");
    if (existing?.pending && ownerGenerationChanged) {
      // Do not supersede active discovery. Wait for its owner to settle, then retry against
      // the published identity so same-generation callers still coalesce.
      lastExternalPublication = existing.pending;
      await racePromiseWithAbortSignal(
        existing.pending.catch(() => undefined),
        options.abortSignal,
      );
      continue;
    }
    try {
      if (existing?.pending && !ownerGenerationChanged) {
        // Matching callers lease the immutable generation they joined even if a queued
        // mismatched caller publishes the next owner immediately after this one settles.
        admission.claim(key, existing);
        lastExternalPublication = existing.pending;
        snapshot = await racePromiseWithAbortSignal(existing.pending, options.abortSignal);
        if (existing.snapshot !== snapshot || existing.needsRefresh) {
          continue;
        }
        owner = existing;
        break;
      }
      if (existing && !staleDynamicOwner && !ownerGenerationChanged) {
        if (existing.needsRefresh) {
          throw existing.refreshError ?? new Error("prepared model runtime refresh is pending");
        }
        if (
          !existing.snapshot ||
          (input.readOnly && !preparedModelRuntimeConfigsMatch(existing.input.config, input.config))
        ) {
          throw new PreparedModelRuntimeOwnerNotPublishedError(
            `prepared model runtime owner was not published for ${input.agentDir}`,
          );
        }
        // The exact keyed owner already carries the prepared selection and snapshot.
        snapshot = existing.snapshot;
      } else {
        // Fresh keys publish a first generation; stale dynamic owners publish a distinct
        // replacement owner because existing leases retain their immutable snapshot, so
        // their release cannot delete the generation admitted for new work at this key.
        const publication = publishModelRuntimeSnapshot(
          input,
          context.owners,
          context.agentBuildCompletions,
          context.getBuildTimeoutMs(),
          undefined,
          provenance,
          options.catalogMode,
          options.pluginGeneration,
          pluginMetadataSnapshot,
        );
        // Publication installs its exact owner synchronously before exposing the pending promise.
        const publishingOwner = context.owners.get(key);
        if (publishingOwner) {
          admission.claim(key, publishingOwner);
        }
        snapshot = await racePromiseWithAbortSignal(publication, options.abortSignal);
      }
    } catch (error) {
      admission.release();
      if (error instanceof PreparedModelRuntimePublicationSupersededError) {
        supersededPublication = error;
        continue;
      }
      throw error;
    }
    const published = context.owners.get(key);
    if (
      context.getPendingReplacement() ||
      !published ||
      published.snapshot !== snapshot ||
      published.needsRefresh ||
      published.pending
    ) {
      continue;
    }
    admission.claim(key, published);
    owner = published;
    break;
  }
  try {
    assertAdmission();
    const configuredOwner = resolveConfiguredOwner(context.owners, input);
    const catalogOwner =
      configuredOwner &&
      ownerKey({
        ...configuredOwner.input,
        loadRuntimePlugins: false,
        runtimePluginSelections: undefined,
      }) === ownerKey({ ...input, loadRuntimePlugins: false, runtimePluginSelections: undefined })
        ? configuredOwner
        : owner;
    snapshot = capturePreparedModelRuntimeCatalog(snapshot, catalogOwner.snapshot);
    const pluginGeneration = owner.pluginGeneration!;
    if (owner.provenance !== provenance) {
      return {
        snapshot,
        pluginGeneration,
        [Symbol.asyncDispose]: retainPreparedPluginGeneration(pluginGeneration),
      };
    }
    assertAdmission();
    if (provenance === "run" && options.retainIdleRunOwner) {
      context.retainedDirectRunOwners.retain(key, owner, context.owners);
    } else if (provenance === "run" && context.getGatewayLifecycleActive()) {
      context.retainedGatewayRunOwners.retain(key, owner, context.owners);
    }
    const releaseGeneration = retainPreparedPluginGeneration(pluginGeneration);
    owner.leaseCount = (owner.leaseCount ?? 0) + 1;
    admission.release();
    let released = false;
    return {
      snapshot,
      pluginGeneration,
      [Symbol.asyncDispose]: async () => {
        if (released) {
          return;
        }
        released = true;
        owner.leaseCount = Math.max(0, (owner.leaseCount ?? 1) - 1);
        // Direct runs retain one idle generation; gateways retain a bounded LRU so repeated selections
        // reuse workspace facts. Identity checks keep old releases from deleting replacements.
        retirePreparedModelRuntimeOwnerIfUnused(
          context.owners,
          key,
          owner,
          context.retainedDirectRunOwners.has(key, owner) ||
            context.retainedGatewayRunOwners.has(key, owner),
        );
        await releaseGeneration();
      },
    };
  } finally {
    admission.release();
  }
}
