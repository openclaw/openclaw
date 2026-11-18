/** Agent-run lease admission for lifecycle-owned prepared model runtimes. */
import { createAbortError, racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { resolvePluginMetadataSnapshotAsync } from "../plugins/plugin-metadata-snapshot.js";
import { runOutsidePluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import {
  getPreparedSharedAuthStoreOwnership,
  prepareSharedAuthStoreOwnership,
} from "./auth-profiles/path-resolve.js";
import { assertPreparedModelRuntimeAdmissionCanWait } from "./prepared-model-runtime-admission.js";
import {
  getPreparedModelRuntimeBorrowedSnapshot,
  getPreparedModelRuntimePluginGeneration,
  runOutsidePreparedModelRuntimePluginGenerationScope,
} from "./prepared-model-runtime-generation-scope.js";
import { capturePreparedModelRuntimeCatalog } from "./prepared-model-runtime.capture.js";
import { isPreparedModelRuntimeMissingOwnerError } from "./prepared-model-runtime.errors.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  PreparedModelRuntimePublicationSupersededError,
  ownerKey,
  normalizePreparedModelRuntimeInput,
  preparedModelRuntimeConfigsMatch,
  publishModelRuntimeSnapshot,
  rebindInputToCommittedConfiguredOwner,
  resolveConfiguredOwner,
  resolveInventoryInput,
  type PreparedModelRuntimeInput,
  type PreparedModelRuntimeLease,
  type PreparedModelRuntimeOwner,
  type PreparedModelRuntimeReplacement,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.owner.js";
import {
  bindPreparedPluginGenerationConfiguredBase,
  getPreparedPluginGenerationConfiguredBase,
  preparedPluginGenerationReusesBase,
  preparedPluginGenerationSupportsSelections,
} from "./prepared-model-runtime.plugin-generation.js";
import { createPreparedModelRuntimeLease } from "./prepared-model-runtime.plugin-lifetime.js";
import {
  retirePreparedModelRuntimeOwnerIfUnused,
  type PreparedModelRuntimeOwnerRetention,
} from "./prepared-model-runtime.retention.js";
import type {
  PreparedModelRuntimeLeaseOptions,
  PreparedModelRuntimeQualification,
  PreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime.types.js";

type PreparedModelRuntimeLeaseContext = {
  captureLifetime(): () => void;
  owners: Map<string, PreparedModelRuntimeOwner>;
  agentBuildCompletions: Map<string, Promise<void>>;
  retainedDirectRunOwners: PreparedModelRuntimeOwnerRetention;
  retainedGatewayRunOwners: PreparedModelRuntimeOwnerRetention;
  getBuildTimeoutMs(): number;
  getGatewayLifecycleActive(): boolean;
  getPendingReplacement(
    input?: PreparedModelRuntimeInput,
  ): PreparedModelRuntimeReplacement | undefined;
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

function preparedModelRuntimeBorrowMatchesInput(
  borrowed: PreparedModelRuntimeSnapshot,
  generation: PreparedModelRuntimePluginGeneration,
  input: PreparedModelRuntimeInput,
  allowWorkspaceChange = false,
): boolean {
  return (
    borrowed.metadataSnapshot === generation.pluginMetadataSnapshot &&
    preparedModelRuntimeConfigsMatch(borrowed.config, input.config) &&
    borrowed.agentId === input.agentId &&
    borrowed.agentDir === input.agentDir &&
    borrowed.inheritedAuthDir === input.inheritedAuthDir &&
    (allowWorkspaceChange || borrowed.workspaceDir === input.workspaceDir) &&
    (!input.allowGatewaySubagentBinding || borrowed.allowGatewaySubagentBinding) &&
    !input.readOnly &&
    !input.loadRuntimePlugins &&
    !input.skipCredentials &&
    !input.env &&
    preparedPluginGenerationSupportsSelections(generation, input)
  );
}

export async function acquirePreparedModelRuntimeLeaseFromOwners(
  rawInput: PreparedModelRuntimeInput,
  provenance: "run" | "ephemeral",
  context: PreparedModelRuntimeLeaseContext,
  options: PreparedModelRuntimeLeaseOptions = {},
): Promise<PreparedModelRuntimeLease> {
  const leaseObservation = options.qualification?.(0);
  leaseObservation?.("lease", "begin");
  let leaseSucceeded = false;
  try {
    const assertLifetime = context.captureLifetime();
    const assertAdmission = () => {
      assertLifetime();
      if (options.abortSignal?.aborted) {
        throw createAbortError("Prepared model runtime lease admission aborted", {
          cause: options.abortSignal.reason,
        });
      }
    };
    const acquire = (observation?: PreparedModelRuntimeQualification) =>
      acquirePreparedModelRuntimeLeaseAttempt(
        rawInput,
        provenance,
        context,
        options,
        assertAdmission,
        observation,
      );
    for (let attempt = 0; ; attempt += 1) {
      const observation = options.qualification?.(attempt + 1);
      observation?.("attempt", "begin");
      try {
        const result = await (attempt === 0
          ? acquire(observation)
          : runOutsidePreparedModelRuntimePluginGenerationScope(() =>
              runOutsidePluginRuntimeGenerationScope(() => acquire(observation)),
            ));
        observation?.("lease-finalize", "ok");
        observation?.("attempt", "ok");
        leaseSucceeded = true;
        return result;
      } catch (error) {
        observation?.("attempt", options.abortSignal?.aborted ? "abort" : "error");
        // Explicit and inherited pins belong to admitted work, including nested completions.
        if (
          !(error instanceof PreparedModelRuntimePublicationSupersededError) ||
          provenance !== "run" ||
          options.pluginGeneration ||
          getPreparedModelRuntimePluginGeneration()
        ) {
          throw error;
        }
        assertAdmission();
        if (attempt === 1) {
          throw new PreparedModelRuntimePublicationSupersededError(
            "Model runtime changed during both preparation attempts; retry the request",
            { cause: error },
          );
        }
      }
    }
  } finally {
    leaseObservation?.(
      "lease",
      leaseSucceeded ? "ok" : options.abortSignal?.aborted ? "abort" : "error",
    );
  }
}

async function acquirePreparedModelRuntimeLeaseAttempt(
  rawInput: PreparedModelRuntimeInput,
  provenance: "run" | "ephemeral",
  context: PreparedModelRuntimeLeaseContext,
  options: PreparedModelRuntimeLeaseOptions,
  assertAdmission: () => void,
  observation?: PreparedModelRuntimeQualification,
): Promise<PreparedModelRuntimeLease> {
  observation?.("borrow-check", "begin");
  assertAdmission();
  const generation = options.pluginGeneration;
  const borrowed = generation && getPreparedModelRuntimeBorrowedSnapshot(generation);
  observation?.("generation-supplied", "mark", generation !== undefined);
  observation?.("borrowed-present", "mark", borrowed !== undefined);
  if (provenance === "run" && options.catalogMode !== "live" && generation && borrowed) {
    const deriveSelections = options.deriveRuntimePluginSelections;
    const input = normalizePreparedModelRuntimeInput({
      ...rawInput,
      ...(deriveSelections
        ? {
            runtimePluginSelections: withPluginMetadataSnapshotScope(
              generation.pluginMetadataSnapshot,
              () => [
                ...(rawInput.runtimePluginSelections ?? []),
                ...deriveSelections({
                  config: rawInput.config,
                  metadataSnapshot: generation.pluginMetadataSnapshot,
                }),
              ],
              { trustConfigIdentity: true },
            ),
          }
        : {}),
    });
    if (preparedModelRuntimeBorrowMatchesInput(borrowed, generation, input)) {
      // Admitted work must finish before replacement can drain its retained generation.
      assertAdmission();
      observation?.("borrowed-matched", "mark", true);
      observation?.("borrow-check", "ok");
      observation?.("return-route", "mark", 1);
      observation?.("lease-finalize", "begin");
      return createPreparedModelRuntimeLease(borrowed, generation);
    }
  }
  observation?.("borrowed-matched", "mark", false);
  observation?.("borrow-check", "ok");
  if (!getPreparedSharedAuthStoreOwnership(rawInput.env ?? process.env)) {
    observation?.("shared-auth", "begin");
    await prepareSharedAuthStoreOwnership(rawInput.env);
    observation?.("shared-auth", "ok");
  } else {
    observation?.("shared-auth", "skip");
  }
  assertAdmission();
  let replacement = context.getPendingReplacement(rawInput);
  if (!replacement) {
    observation?.("replacement-wait", "skip");
  }
  // Drain, retirement, and failed-activation recovery each own one gate; further churn is best effort.
  // A refresh continuation has already run tools, so it waits through back-to-back reloads: each
  // gate is one reload that settles within its own drain and stop budget, a gate that settles
  // without giving way ends the wait, and the run's abort signal still cancels it.
  const maxWaits = options.waitForReplacementPublication ? Number.POSITIVE_INFINITY : 3;
  for (let waits = 0; replacement && waits < maxWaits; waits += 1) {
    assertPreparedModelRuntimeAdmissionCanWait();
    const awaited = replacement;
    observation?.("replacement-wait", "begin", waits + 1);
    await racePromiseWithAbortSignal(awaited.promise, options.abortSignal);
    observation?.("replacement-wait", "ok", waits + 1);
    assertAdmission();
    replacement = context.getPendingReplacement(rawInput);
    // An unbounded wait still needs each gate to give way to the next reload.
    if (replacement === awaited && options.waitForReplacementPublication) {
      break;
    }
  }
  if (replacement) {
    throw new PreparedModelRuntimeOwnerNotPublishedError(
      `prepared model runtime lease admission made no publication progress for ${rawInput.agentDir}; retry the request`,
    );
  }

  let input = normalizePreparedModelRuntimeInput({
    ...rawInput,
    preserveWorkspaceDirOnRefresh:
      rawInput.preserveWorkspaceDirOnRefresh ?? rawInput.workspaceDir !== undefined,
  });
  if (provenance === "run" && context.getGatewayLifecycleActive()) {
    observation?.("gateway-active", "mark", true);
    const configured = resolveConfiguredOwner(context.owners, input);
    if (configured?.pending) {
      assertPreparedModelRuntimeAdmissionCanWait(configured);
      observation?.("configured-owner-wait", "begin");
      await racePromiseWithAbortSignal(configured.pending, options.abortSignal);
      observation?.("configured-owner-wait", "ok");
      assertAdmission();
    } else {
      observation?.("configured-owner-wait", "skip");
    }
  } else {
    observation?.("gateway-active", "mark", false);
    observation?.("configured-owner-wait", "skip");
  }
  if (provenance === "run" && !options.pluginGeneration && context.getGatewayLifecycleActive()) {
    try {
      input = rebindInputToCommittedConfiguredOwner(context.owners, input);
    } catch (error) {
      if (!isPreparedModelRuntimeMissingOwnerError(error)) {
        throw error;
      }
      const existing = context.owners.get(ownerKey(input));
      const reservedSetup = input.agentId !== undefined && isReservedSystemAgentId(input.agentId);
      if (!existing && !reservedSetup) {
        throw error;
      }
    }
  }

  let pluginMetadataSnapshot = options.pluginMetadataSnapshot;
  if (options.deriveRuntimePluginSelections) {
    // Preserve nullish precedence; do not invoke the resolver merely to observe it.
    const generationMetadata = options.pluginGeneration?.pluginMetadataSnapshot;
    if (generationMetadata != null) {
      observation?.("metadata-source", "mark", 1);
      observation?.("metadata-resolve", "skip");
      pluginMetadataSnapshot = generationMetadata;
    } else if (pluginMetadataSnapshot != null) {
      observation?.("metadata-source", "mark", 2);
      observation?.("metadata-resolve", "skip");
    } else {
      observation?.("metadata-source", "mark", 3);
      observation?.("metadata-resolve", "begin");
      pluginMetadataSnapshot = await resolvePluginMetadataSnapshotAsync({
        config: input.config,
        env: input.env,
        workspaceDir: input.workspaceDir,
        allowWorkspaceScopedCurrent: true,
      });
      observation?.("metadata-resolve", "ok");
    }
    const metadataSnapshot = pluginMetadataSnapshot;
    const deriveSelections = options.deriveRuntimePluginSelections;
    observation?.("derive-selections", "begin");
    input = withPluginMetadataSnapshotScope(
      pluginMetadataSnapshot,
      () =>
        normalizePreparedModelRuntimeInput({
          ...input,
          runtimePluginSelections: [
            ...(rawInput.runtimePluginSelections ?? []),
            ...deriveSelections({ config: input.config, metadataSnapshot }),
          ],
        }),
      { trustConfigIdentity: true },
    );
    observation?.("derive-selections", "ok");
  } else {
    observation?.("metadata-resolve", "skip");
    observation?.("derive-selections", "skip");
  }

  const key = ownerKey(input);
  const admission = createPreparedModelRuntimeAdmissionClaim(context);
  try {
    let owner = context.owners.get(key);
    observation?.("owner-present", "mark", owner !== undefined);
    const configuredOwner = resolveConfiguredOwner(context.owners, input);
    const requestedGeneration = options.pluginGeneration;
    const activeBorrowedSnapshot =
      requestedGeneration && getPreparedModelRuntimeBorrowedSnapshot(requestedGeneration);
    const generationAuthorityOwner =
      configuredOwner ??
      (activeBorrowedSnapshot
        ? resolveConfiguredOwner(context.owners, {
            ...input,
            agentId: activeBorrowedSnapshot.agentId,
            agentDir: activeBorrowedSnapshot.agentDir,
            config: activeBorrowedSnapshot.config,
            inheritedAuthDir: activeBorrowedSnapshot.inheritedAuthDir,
            workspaceDir: activeBorrowedSnapshot.workspaceDir,
          })
        : undefined);
    const configuredGeneration = generationAuthorityOwner?.pluginGeneration;
    const requiredConfiguredGeneration =
      requestedGeneration && getPreparedPluginGenerationConfiguredBase(requestedGeneration);
    // A selected run view may change execution workspaces only while its exact lease remains open
    // and the configured generation it was derived from still owns publication authority.
    const requestedGenerationIsCurrent =
      configuredGeneration === requestedGeneration ||
      (requestedGeneration !== undefined &&
        configuredGeneration !== undefined &&
        activeBorrowedSnapshot !== undefined &&
        input.runtimePluginSelections !== undefined &&
        requiredConfiguredGeneration === configuredGeneration &&
        preparedModelRuntimeBorrowMatchesInput(
          activeBorrowedSnapshot,
          requestedGeneration,
          input,
          true,
        ));
    if (
      provenance === "run" &&
      context.getGatewayLifecycleActive() &&
      requestedGeneration &&
      ((requiredConfiguredGeneration !== undefined && !generationAuthorityOwner) ||
        (generationAuthorityOwner &&
          (generationAuthorityOwner.needsRefresh || !requestedGenerationIsCurrent)))
    ) {
      throw new PreparedModelRuntimePublicationSupersededError(
        `prepared model runtime plugin generation was superseded for ${input.agentDir}`,
      );
    }

    const inventoryInput = resolveInventoryInput(input, configuredOwner);
    if (
      provenance === "run" &&
      context.getGatewayLifecycleActive() &&
      options.catalogMode === "static" &&
      !options.pluginGeneration &&
      !options.pluginMetadataSnapshot &&
      !input.readOnly &&
      !input.loadRuntimePlugins &&
      !input.skipCredentials &&
      configuredOwner?.snapshot &&
      configuredOwner.pluginGeneration &&
      !configuredOwner.pending &&
      !configuredOwner.needsRefresh &&
      !configuredOwner.refreshError &&
      configuredOwner.snapshot.config === input.config &&
      ownerKey({ ...configuredOwner.input, runtimePluginSelections: undefined }) ===
        ownerKey({ ...inventoryInput, runtimePluginSelections: undefined }) &&
      preparedPluginGenerationSupportsSelections(configuredOwner.pluginGeneration, inventoryInput)
    ) {
      owner = configuredOwner;
      observation?.("configured-reuse", "mark", true);
    } else {
      observation?.("configured-reuse", "mark", false);
    }

    const ownerGenerationChanged = () => {
      const changed =
        (options.pluginGeneration !== undefined &&
          !preparedPluginGenerationReusesBase(
            owner?.pending ? owner.pendingPluginGeneration : owner?.pluginGeneration,
            options.pluginGeneration,
          )) ||
        (options.catalogMode === "live" && owner?.catalogMode === "static");
      observation?.("generation-changed", "mark", changed);
      return changed;
    };
    if (owner?.pending) {
      assertPreparedModelRuntimeAdmissionCanWait(owner);
      admission.claim(key, owner);
      observation?.("owner-pending-wait", "begin");
      await racePromiseWithAbortSignal(owner.pending, options.abortSignal);
      observation?.("owner-pending-wait", "ok");
      assertAdmission();
    } else {
      observation?.("owner-pending-wait", "skip");
    }

    let snapshot: PreparedModelRuntimeSnapshot;
    const staleDynamicOwner =
      owner?.needsRefresh && (owner.provenance === "run" || owner.provenance === "ephemeral");
    observation?.("owner-stale", "mark", Boolean(staleDynamicOwner));
    if (!owner || staleDynamicOwner || ownerGenerationChanged()) {
      observation?.("publish", "begin");
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
        undefined,
        observation,
      );
      owner = context.owners.get(key);
      if (!owner) {
        throw new PreparedModelRuntimeOwnerNotPublishedError(
          `prepared model runtime owner was not published for ${input.agentDir}`,
        );
      }
      admission.claim(key, owner);
      snapshot = await racePromiseWithAbortSignal(publication, options.abortSignal);
      observation?.("publish", "ok");
    } else {
      observation?.("publish", "skip");
      if (owner.needsRefresh) {
        throw owner.refreshError ?? new Error("prepared model runtime refresh is pending");
      }
      if (
        !owner.snapshot ||
        (input.readOnly && !preparedModelRuntimeConfigsMatch(owner.input.config, input.config))
      ) {
        throw new PreparedModelRuntimeOwnerNotPublishedError(
          `prepared model runtime owner was not published for ${input.agentDir}`,
        );
      }
      snapshot = owner.snapshot;
    }
    observation?.("lease-finalize", "begin");
    assertAdmission();
    if (owner.needsRefresh || owner.snapshot !== snapshot) {
      throw new PreparedModelRuntimePublicationSupersededError(
        `prepared model runtime publication was superseded for ${input.agentDir}`,
      );
    }
    // Execution purpose isolates plugins, not the configured agent's published inventory.
    const catalogOwner =
      configuredOwner &&
      ownerKey({
        ...configuredOwner.input,
        loadRuntimePlugins: false,
        runtimePluginPurpose: undefined,
        runtimePluginSelections: undefined,
      }) ===
        ownerKey({
          ...inventoryInput,
          loadRuntimePlugins: false,
          runtimePluginPurpose: undefined,
          runtimePluginSelections: undefined,
        })
        ? configuredOwner
        : owner;
    snapshot = capturePreparedModelRuntimeCatalog(snapshot, catalogOwner.snapshot);
    const pluginGeneration = owner.pluginGeneration!;
    if (options.pluginGeneration) {
      bindPreparedPluginGenerationConfiguredBase(pluginGeneration, options.pluginGeneration);
    }
    if (owner.provenance !== provenance) {
      observation?.("return-route", "mark", 2);
      return createPreparedModelRuntimeLease(snapshot, pluginGeneration);
    }
    if (provenance === "run" && options.retainIdleRunOwner) {
      context.retainedDirectRunOwners.retain(key, owner, context.owners);
    } else if (provenance === "run" && context.getGatewayLifecycleActive()) {
      context.retainedGatewayRunOwners.retain(key, owner, context.owners);
    }
    const lease = createPreparedModelRuntimeLease(snapshot, pluginGeneration, () => {
      owner.leaseCount = Math.max(0, (owner.leaseCount ?? 1) - 1);
      retirePreparedModelRuntimeOwnerIfUnused(
        context.owners,
        key,
        owner,
        context.retainedDirectRunOwners.has(key, owner) ||
          context.retainedGatewayRunOwners.has(key, owner),
      );
    });
    owner.leaseCount = (owner.leaseCount ?? 0) + 1;
    admission.release();
    observation?.("return-route", "mark", 3);
    return lease;
  } finally {
    admission.release();
  }
}
