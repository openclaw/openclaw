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
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import {
  retirePreparedModelRuntimeOwnerIfUnused,
  type PreparedModelRuntimeOwnerRetention,
} from "./prepared-model-runtime.retention.js";
import type {
  PreparedModelRuntimeLeaseOptions,
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
  const assertLifetime = context.captureLifetime();
  const assertAdmission = () => {
    assertLifetime();
    if (options.abortSignal?.aborted) {
      throw createAbortError("Prepared model runtime lease admission aborted", {
        cause: options.abortSignal.reason,
      });
    }
  };
  const acquire = () =>
    acquirePreparedModelRuntimeLeaseAttempt(
      rawInput,
      provenance,
      context,
      options,
      assertAdmission,
    );
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await (attempt === 0
        ? acquire()
        : runOutsidePreparedModelRuntimePluginGenerationScope(() =>
            runOutsidePluginRuntimeGenerationScope(acquire),
          ));
    } catch (error) {
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
}

async function acquirePreparedModelRuntimeLeaseAttempt(
  rawInput: PreparedModelRuntimeInput,
  provenance: "run" | "ephemeral",
  context: PreparedModelRuntimeLeaseContext,
  options: PreparedModelRuntimeLeaseOptions,
  assertAdmission: () => void,
): Promise<PreparedModelRuntimeLease> {
  assertAdmission();
  const generation = options.pluginGeneration;
  const borrowed = generation && getPreparedModelRuntimeBorrowedSnapshot(generation);
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
      return {
        snapshot: borrowed,
        pluginGeneration: generation,
        [Symbol.asyncDispose]: retainPreparedPluginGeneration(generation),
      };
    }
  }
  if (!getPreparedSharedAuthStoreOwnership(rawInput.env ?? process.env)) {
    await prepareSharedAuthStoreOwnership(rawInput.env);
  }
  assertAdmission();
  let replacement = context.getPendingReplacement(rawInput);
  // Drain, retirement, and failed-activation recovery each own one gate; further churn is best effort.
  // A refresh continuation has already run tools, so it waits through back-to-back reloads: each
  // gate is one reload that settles within its own drain and stop budget, a gate that settles
  // without giving way ends the wait, and the run's abort signal still cancels it.
  const maxWaits = options.waitForReplacementPublication ? Number.POSITIVE_INFINITY : 3;
  for (let waits = 0; replacement && waits < maxWaits; waits += 1) {
    assertPreparedModelRuntimeAdmissionCanWait();
    const awaited = replacement;
    await racePromiseWithAbortSignal(awaited.promise, options.abortSignal);
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
    const configured = resolveConfiguredOwner(context.owners, input);
    if (configured?.pending) {
      assertPreparedModelRuntimeAdmissionCanWait(configured);
      await racePromiseWithAbortSignal(configured.pending, options.abortSignal);
      assertAdmission();
    }
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
    pluginMetadataSnapshot =
      options.pluginGeneration?.pluginMetadataSnapshot ??
      pluginMetadataSnapshot ??
      (await resolvePluginMetadataSnapshotAsync({
        config: input.config,
        env: input.env,
        workspaceDir: input.workspaceDir,
        allowWorkspaceScopedCurrent: true,
      }));
    const metadataSnapshot = pluginMetadataSnapshot;
    const deriveSelections = options.deriveRuntimePluginSelections;
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
  }

  const key = ownerKey(input);
  const admission = createPreparedModelRuntimeAdmissionClaim(context);
  try {
    let owner = context.owners.get(key);
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

    // Gateway inventory belongs to the configured agent; the session cwd only controls execution.
    const inventoryInput = context.getGatewayLifecycleActive()
      ? { ...input, workspaceDir: configuredOwner?.input.workspaceDir }
      : input;
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
    }

    const ownerGenerationChanged = () =>
      (options.pluginGeneration !== undefined &&
        !preparedPluginGenerationReusesBase(
          owner?.pending ? owner.pendingPluginGeneration : owner?.pluginGeneration,
          options.pluginGeneration,
        )) ||
      (options.catalogMode === "live" && owner?.catalogMode === "static");
    if (owner?.pending) {
      assertPreparedModelRuntimeAdmissionCanWait(owner);
      admission.claim(key, owner);
      await racePromiseWithAbortSignal(owner.pending, options.abortSignal);
      assertAdmission();
    }

    let snapshot: PreparedModelRuntimeSnapshot;
    const staleDynamicOwner =
      owner?.needsRefresh && (owner.provenance === "run" || owner.provenance === "ephemeral");
    if (!owner || staleDynamicOwner || ownerGenerationChanged()) {
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
      owner = context.owners.get(key);
      if (!owner) {
        throw new PreparedModelRuntimeOwnerNotPublishedError(
          `prepared model runtime owner was not published for ${input.agentDir}`,
        );
      }
      admission.claim(key, owner);
      snapshot = await racePromiseWithAbortSignal(publication, options.abortSignal);
    } else {
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
      return {
        snapshot,
        pluginGeneration,
        [Symbol.asyncDispose]: retainPreparedPluginGeneration(pluginGeneration),
      };
    }
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
