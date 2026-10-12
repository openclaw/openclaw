/** Agent-run lease admission for lifecycle-owned prepared model runtimes. */
import { createAbortError, racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import { assertPreparedModelRuntimeAdmissionCanWait } from "./prepared-model-runtime-admission.js";
import { getPreparedModelRuntimeBorrowedSnapshot } from "./prepared-model-runtime-generation-scope.js";
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
  assertAdmission();
  let replacement = context.getPendingReplacement(rawInput);
  // Drain, retirement, and failed-activation recovery each own one gate; further churn is best effort.
  for (let waits = 0; replacement && waits < 3; waits += 1) {
    assertPreparedModelRuntimeAdmissionCanWait();
    await racePromiseWithAbortSignal(replacement.promise, options.abortSignal);
    assertAdmission();
    replacement = context.getPendingReplacement(rawInput);
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
      resolvePluginMetadataSnapshot({
        config: input.config,
        env: input.env,
        workspaceDir: input.workspaceDir,
        allowWorkspaceScopedCurrent: true,
      });
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
    if (
      provenance === "run" &&
      context.getGatewayLifecycleActive() &&
      options.pluginGeneration &&
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
        // Nested work borrows its still-open parent; it cannot publish or widen that authority.
        assertAdmission();
        return {
          snapshot: borrowed,
          pluginGeneration: options.pluginGeneration,
          [Symbol.asyncDispose]: retainPreparedPluginGeneration(options.pluginGeneration),
        };
      }
      throw new PreparedModelRuntimePublicationSupersededError(
        `prepared model runtime plugin generation was superseded for ${input.agentDir}`,
      );
    }

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
        ownerKey({ ...input, runtimePluginSelections: undefined }) &&
      preparedPluginGenerationSupportsSelections(configuredOwner.pluginGeneration, input)
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
    // Reload during acquisition is best-effort: fail this request instead of restarting preparation.
    if (owner.needsRefresh || owner.snapshot !== snapshot) {
      throw new PreparedModelRuntimePublicationSupersededError(
        `prepared model runtime publication was superseded for ${input.agentDir}`,
      );
    }
    // Discovery rows are published for the configured agent. Execution cwd stays on the run snapshot.
    const catalogOwner =
      configuredOwner &&
      ownerKey({
        ...configuredOwner.input,
        workspaceDir: undefined,
        loadRuntimePlugins: false,
        runtimePluginSelections: undefined,
      }) ===
        ownerKey({
          ...input,
          workspaceDir: undefined,
          loadRuntimePlugins: false,
          runtimePluginSelections: undefined,
        })
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
