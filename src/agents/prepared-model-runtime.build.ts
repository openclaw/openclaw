import { performance } from "node:perf_hooks";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runAbortableTimeout } from "../node-host/with-timeout.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { collectConfiguredAgentHarnessRuntimes } from "./harness-runtimes.js";
import {
  createFullModelCatalogAccess,
  MAX_CONCURRENT_FULL_MODEL_CATALOG_BUILDS,
} from "./prepared-model-runtime.catalog-access.js";
import type {
  PreparedModelRuntimeAgentFacts,
  PreparedModelRuntimeCatalogFacts,
  PreparedModelRuntimeCatalogSource,
} from "./prepared-model-runtime.catalog-contract.js";
import {
  assertPreparedModelRuntimeInputCurrent,
  assertPreparedModelRuntimeCandidatesCurrent,
  PreparedModelRuntimePublicationSupersededError,
} from "./prepared-model-runtime.errors.js";
import {
  fingerprintPreparedRuntimeFacts,
  prepareConfiguredRuntimeFactsBatch,
  prepareWorkspaceBuildGroup,
} from "./prepared-model-runtime.facts.js";
import {
  createPreparedModelRuntimeSnapshot,
  prepareFullCatalogFacts,
} from "./prepared-model-runtime.full-catalog.js";
import {
  createPreparedInboundRegistryLoader,
  preparedModelRuntimeWorkspaceFactsKey,
} from "./prepared-model-runtime.inbound-registry.js";
import {
  discardPreparedPluginGeneration,
  registerPreparedPluginLifetime,
} from "./prepared-model-runtime.plugin-lifetime.js";
import { PreparedModelRuntimeBuildResources } from "./prepared-model-runtime.resources.js";
import { prepareAgentCatalogSource } from "./prepared-model-runtime.scoped-catalog.js";
import type {
  PreparedModelRuntimeBuildStats,
  PreparedModelRuntimeCatalogMode,
  PreparedModelRuntimeInput,
  PreparedModelRuntimeOwner,
  PreparedModelRuntimePluginGeneration,
  PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.types.js";

const MAX_CONCURRENT_MODEL_RUNTIME_AGENT_SOURCE_BUILDS = 2;

export type PreparedModelRuntimeBuildCandidate = Readonly<{
  input: PreparedModelRuntimeInput;
  catalogOwner: PreparedModelRuntimeSnapshot["catalogOwner"];
  inventoryOwner?: Pick<PreparedModelRuntimeOwner, "catalogInventory" | "catalogAttempt">;
  pluginGeneration?: PreparedModelRuntimePluginGeneration;
  prepareInboundPluginRegistry?: boolean;
  isGenerationCurrent?: () => boolean;
  isBuildCurrent?: () => boolean;
  /** Shared publication guards run before workspace preparation; registration guards do not. */
  isPreparationCurrent?: () => boolean;
  ownsRegistryResources?: boolean;
}>;

export type PreparedModelRuntimeBuildResult = Readonly<{
  snapshot: PreparedModelRuntimeSnapshot;
  pluginGeneration: PreparedModelRuntimePluginGeneration;
}>;

function groupBuildCandidates<K>(
  candidates: readonly PreparedModelRuntimeBuildCandidate[],
  keyOf: (candidate: PreparedModelRuntimeBuildCandidate) => K,
): Map<K, PreparedModelRuntimeBuildCandidate[]> {
  const groups = new Map<K, PreparedModelRuntimeBuildCandidate[]>();
  for (const candidate of candidates) {
    const key = keyOf(candidate);
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  return groups;
}

async function buildSnapshotBatch(
  candidates: readonly PreparedModelRuntimeBuildCandidate[],
  catalogMode: PreparedModelRuntimeCatalogMode,
  pluginMetadataSnapshot?: PreparedModelRuntimePluginGeneration["pluginMetadataSnapshot"],
  onBuildStats?: (stats: PreparedModelRuntimeBuildStats) => void,
  includeCredentialProviders = catalogMode === "live",
  onStage?: (stage: string) => void,
  registryResources?: PreparedModelRuntimeBuildResources,
): Promise<PreparedModelRuntimeBuildResult[]> {
  const preparedGenerations = new Set<PreparedModelRuntimePluginGeneration>();
  try {
    const generations = groupBuildCandidates(candidates, (candidate) => candidate.pluginGeneration);
    const fresh = generations.get(undefined) ?? [];
    // Reusable generations precede fresh ones; preserve first-seen order within each group.
    generations.delete(undefined);
    generations.set(undefined, fresh);
    const groups = [...generations].flatMap(([pluginGeneration, generationCandidates]) =>
      [
        ...groupBuildCandidates(generationCandidates, (candidate) => {
          const workspace = preparedModelRuntimeWorkspaceFactsKey(candidate.input);
          if (candidate.ownsRegistryResources) {
            return `owned\0${workspace}`;
          }
          const kind = candidate.prepareInboundPluginRegistry ? "configured" : "dynamic";
          return pluginGeneration ? workspace : `${kind}\0${workspace}`;
        }).values(),
      ].map((groupCandidates) => ({ groupCandidates, pluginGeneration })),
    );
    const preparedInputs = new Map<
      PreparedModelRuntimeInput,
      {
        agentFacts: PreparedModelRuntimeAgentFacts;
        pluginGeneration: PreparedModelRuntimePluginGeneration;
      }
    >();
    const requirePreparedInput = (input: PreparedModelRuntimeInput) => {
      const prepared = preparedInputs.get(input);
      if (!prepared) {
        throw new Error(`prepared model runtime facts missing for ${input.agentDir}`);
      }
      return prepared;
    };
    const loadInboundPluginRegistry = createPreparedInboundRegistryLoader();
    // Config objects can change between publications. Share this projection only
    // inside the current build batch so every later publication reads fresh config.
    const configuredHarnessRuntimesByConfig = new Map<OpenClawConfig, readonly string[]>();
    let runtimePluginMs = 0;
    let pluginMetadataMs = 0;
    let staticProviderCatalogMs = 0;
    let ambientCredentialsMs = 0;
    let agentFactsMs = 0;
    let configuredProjectionMs = 0;
    const workspaceFactsStartedAt = performance.now();
    // Workspace plugin loading and static hooks are intentionally sequential. Large parallel
    // workspace fanout recreates the CPU/RSS spike this generation boundary is meant to contain.
    for (const { groupCandidates, pluginGeneration } of groups) {
      for (const candidate of groupCandidates) {
        assertPreparedModelRuntimeInputCurrent(candidate.input, candidate.isPreparationCurrent);
      }
      const prepareInboundPluginRegistry = groupCandidates.some(
        (candidate) => candidate.prepareInboundPluginRegistry,
      );
      const preferBuiltPluginArtifacts =
        pluginGeneration?.preferBuiltPluginArtifacts ?? prepareInboundPluginRegistry;
      const getConfiguredHarnessRuntimes = () => {
        const config = groupCandidates[0]!.input.config;
        let runtimes = configuredHarnessRuntimesByConfig.get(config);
        if (!runtimes) {
          runtimes = collectConfiguredAgentHarnessRuntimes(config);
          configuredHarnessRuntimesByConfig.set(config, runtimes);
        }
        return runtimes;
      };
      const prepared = await prepareWorkspaceBuildGroup(
        groupCandidates.map(({ input }) => input),
        catalogMode,
        {
          preferBuiltPluginArtifacts,
          includeCredentialProviders,
          getConfiguredHarnessRuntimes,
          onStage,
          ...(groupCandidates.some((candidate) => candidate.ownsRegistryResources)
            ? { registryResources }
            : {}),
        },
        prepareInboundPluginRegistry ? loadInboundPluginRegistry : undefined,
        pluginGeneration,
        pluginMetadataSnapshot,
      );
      preparedGenerations.add(prepared.pluginGeneration);
      assertPreparedModelRuntimeCandidatesCurrent(groupCandidates);
      runtimePluginMs += prepared.buildStats.runtimePluginMs;
      pluginMetadataMs += prepared.buildStats.pluginMetadataMs;
      staticProviderCatalogMs += prepared.buildStats.staticProviderCatalogMs;
      ambientCredentialsMs += prepared.buildStats.ambientCredentialsMs;
      agentFactsMs += prepared.buildStats.agentFactsMs;
      configuredProjectionMs += prepared.buildStats.configuredProjectionMs;
      for (const agentFacts of prepared.agentFacts) {
        preparedInputs.set(agentFacts.input, {
          agentFacts,
          pluginGeneration: prepared.pluginGeneration,
        });
      }
    }
    const workspaceFactsMs = performance.now() - workspaceFactsStartedAt;
    const catalogSourceStartedAt = performance.now();
    onStage?.("agent catalog sources");
    const catalogSources = new Map<PreparedModelRuntimeInput, PreparedModelRuntimeCatalogSource>();
    if (catalogMode === "live") {
      const sourceCandidatesByAgentDir = groupBuildCandidates(
        candidates,
        ({ input }) => input.agentDir,
      );
      const sourceErrors: unknown[] = [];
      const sourceBuild = await runTasksWithConcurrency({
        limit: MAX_CONCURRENT_MODEL_RUNTIME_AGENT_SOURCE_BUILDS,
        errorMode: "stop",
        onTaskError: (error) => {
          sourceErrors.push(error);
        },
        tasks: [...sourceCandidatesByAgentDir.values()].map((sourceCandidates) => async () => {
          // Generated catalogs are agent-directory owned. Preserve write serialization within one
          // directory while allowing bounded progress across distinct agents.
          for (const candidate of sourceCandidates) {
            const { input } = candidate;
            const { agentFacts, pluginGeneration } = requirePreparedInput(input);
            // A replacement waits for this batch's completion. Stop the stale batch before another
            // same-directory write so a superseded generation cannot overwrite catalog state.
            assertPreparedModelRuntimeInputCurrent(input, candidate.isBuildCurrent);
            const catalogSource = await prepareAgentCatalogSource(
              agentFacts,
              pluginGeneration,
              catalogMode,
            );
            assertPreparedModelRuntimeInputCurrent(input, candidate.isBuildCurrent);
            catalogSources.set(input, catalogSource);
          }
        }),
      });
      if (sourceBuild.hasError) {
        // A superseded owner is lifecycle control flow. Preserve any genuine in-flight sibling
        // failure so auth refresh diagnostics do not disappear behind that expected cancellation.
        throw toStringifiedError(
          sourceErrors.find(
            (error) => !(error instanceof PreparedModelRuntimePublicationSupersededError),
          ) ?? sourceBuild.firstError,
        );
      }
    }
    const catalogSourceMs = performance.now() - catalogSourceStartedAt;
    const preparedCatalogs = new Map<PreparedModelRuntimeInput, PreparedModelRuntimeCatalogFacts>();
    let runtimeRegistryCount = 0;
    const registryStartedAt = performance.now();
    onStage?.("model registries");
    if (catalogMode === "live") {
      // Explicit live owners still request the complete inventory. Keep those builds sequential
      // instead of multiplying heap and GC pressure when a command names several agents.
      for (const candidate of candidates) {
        const { input } = candidate;
        const { agentFacts, pluginGeneration } = requirePreparedInput(input);
        const catalogSource = catalogSources.get(input);
        if (!catalogSource) {
          throw new Error(`prepared model runtime catalog source missing for ${input.agentDir}`);
        }
        assertPreparedModelRuntimeInputCurrent(input, candidate.isBuildCurrent);
        preparedCatalogs.set(
          input,
          await prepareFullCatalogFacts(agentFacts, pluginGeneration, catalogMode, catalogSource),
        );
        assertPreparedModelRuntimeInputCurrent(input, candidate.isBuildCurrent);
        runtimeRegistryCount += 1;
      }
    } else {
      for (const { groupCandidates } of groups) {
        assertPreparedModelRuntimeCandidatesCurrent(groupCandidates);
        const { pluginGeneration } = requirePreparedInput(groupCandidates[0]!.input);
        const batch = prepareConfiguredRuntimeFactsBatch({
          agentFacts: groupCandidates.map(({ input }) => requirePreparedInput(input).agentFacts),
          pluginGeneration,
        });
        runtimeRegistryCount += batch.registryCount;
        for (const [input, catalogFacts] of batch.catalogs) {
          preparedCatalogs.set(input, catalogFacts);
        }
        assertPreparedModelRuntimeCandidatesCurrent(groupCandidates);
      }
    }
    const registryMs = performance.now() - registryStartedAt;
    const preparedAgentFacts = [...preparedInputs.values()].map(({ agentFacts }) => agentFacts);
    const configuredRuntimeModelCount = [...preparedCatalogs.values()].reduce(
      (count, facts) => count + facts.configuredRuntimeModels.length,
      0,
    );
    const generatedCatalogPluginCount = new Set(
      preparedAgentFacts.flatMap((facts) => facts.configuredGeneratedCatalogPluginIds),
    ).size;
    const generatedCatalogReadCount = preparedAgentFacts.reduce(
      (count, facts) => count + facts.configuredGeneratedCatalogPluginIds.length,
      0,
    );
    onBuildStats?.({
      agentCount: candidates.length,
      workspaceGroupCount: groups.length,
      configuredFactsGroupCount: groups.length,
      catalogSourceCount:
        catalogMode === "live"
          ? preparedAgentFacts.filter(({ input }) => !input.readOnly).length
          : 0,
      credentialGroupCount: new Set(
        preparedAgentFacts.map(({ credentials }) => fingerprintPreparedRuntimeFacts(credentials)),
      ).size,
      catalogGroupCount: catalogMode === "live" ? candidates.length : 0,
      runtimeRegistryCount,
      configuredRuntimeModelCount,
      generatedCatalogPluginCount,
      generatedCatalogReadCount,
      workspaceFactsMs,
      runtimePluginMs,
      pluginMetadataMs,
      staticProviderCatalogMs,
      ambientCredentialsMs,
      agentFactsMs,
      configuredProjectionMs,
      catalogSourceMs,
      registryMs,
      sourceConcurrencyLimit: MAX_CONCURRENT_MODEL_RUNTIME_AGENT_SOURCE_BUILDS,
      fullCatalogConcurrencyLimit: MAX_CONCURRENT_FULL_MODEL_CATALOG_BUILDS,
    });
    assertPreparedModelRuntimeCandidatesCurrent(candidates);
    return candidates.map((candidate) => {
      const { input } = candidate;
      const { agentFacts, pluginGeneration } = requirePreparedInput(input);
      const catalogFacts = preparedCatalogs.get(input);
      if (!catalogFacts) {
        throw new Error(`prepared model runtime snapshot facts missing for ${input.agentDir}`);
      }
      return {
        snapshot: createPreparedModelRuntimeSnapshot(
          candidate.catalogOwner,
          agentFacts,
          pluginGeneration,
          catalogFacts,
          createFullModelCatalogAccess({
            agentFacts,
            catalogFacts,
            pluginGeneration,
            isCurrent: candidate.isGenerationCurrent ?? (() => false),
            inventoryOwner: candidate.inventoryOwner ?? {},
          }),
        ),
        pluginGeneration,
      };
    });
  } catch (error) {
    const cleanup = await Promise.allSettled(
      [...preparedGenerations].map(discardPreparedPluginGeneration),
    );
    const failures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) {
      throw new AggregateError([error, ...failures], "Prepared model build and cleanup failed", {
        cause: error,
      });
    }
    throw error;
  }
}

export function startSerializedSnapshotBuildBatch(
  candidates: readonly PreparedModelRuntimeBuildCandidate[],
  agentBuildCompletions: Map<string, Promise<void>>,
  buildTimeoutMs: number,
  catalogMode: PreparedModelRuntimeCatalogMode = "live",
  onBuildStats?: (stats: PreparedModelRuntimeBuildStats) => void,
  pluginMetadataSnapshot?: PreparedModelRuntimePluginGeneration["pluginMetadataSnapshot"],
  includeCredentialProviders = catalogMode === "live",
): {
  pending: Promise<PreparedModelRuntimeBuildResult[]>;
  completion: Promise<void>;
} {
  const agentDirs = [...new Set(candidates.map(({ input }) => input.agentDir))];
  let stage = "previous generation completion";
  const previousBuildCompletions = agentDirs
    .map((agentDir) => agentBuildCompletions.get(agentDir))
    .filter((completion) => completion !== undefined);
  // Lifecycle events may overlap. The timeout covers queueing plus this build, while completion
  // follows the real work so a timed-out generation can never overlap a replacement.
  const startBuild = (async () => {
    // Register before waiting: shutdown also owns resources from unfinished builds.
    registerPreparedPluginLifetime();
    await using registryResources = new PreparedModelRuntimeBuildResources();
    if (previousBuildCompletions.length > 0) {
      await Promise.all(previousBuildCompletions);
      // Queued publications register while the prior build settles. Recheck them here so a
      // retired owner cannot start expensive workspace preparation ahead of its replacement.
      assertPreparedModelRuntimeCandidatesCurrent(candidates);
    }
    return await buildSnapshotBatch(
      candidates,
      catalogMode,
      pluginMetadataSnapshot,
      onBuildStats,
      includeCredentialProviders,
      (nextStage) => {
        stage = nextStage;
      },
      registryResources,
    );
  })();
  let abandoned = false;
  const pending = runAbortableTimeout(
    () => startBuild,
    buildTimeoutMs,
    () => `prepared model runtime publication (${stage})`,
  ).catch((error: unknown) => {
    abandoned = true;
    throw error;
  });
  // A timeout only settles its observer. Serialize later builds behind the raw work
  // and disposal of any result that can no longer be published.
  const completion = startBuild
    .then(
      async (results) => {
        if (abandoned) {
          await Promise.all(
            results.map(({ pluginGeneration }) =>
              discardPreparedPluginGeneration(pluginGeneration),
            ),
          );
        }
      },
      () => {},
    )
    .then(
      () => {},
      () => {},
    );
  for (const agentDir of agentDirs) {
    agentBuildCompletions.set(agentDir, completion);
    void completion.then(() => {
      if (agentBuildCompletions.get(agentDir) === completion) {
        agentBuildCompletions.delete(agentDir);
      }
    });
  }
  return { pending, completion };
}
