import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { captureRuntimeConfig } from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runAbortableTimeout } from "../node-host/with-timeout.js";
import { createDeferredCore } from "../shared/deferred.js";
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
  prepareConfiguredModelFacts,
  prepareConfiguredRuntimeFactsBatch,
  prepareWorkspaceBuildGroup,
  type PreparedConfiguredModelRegistries,
} from "./prepared-model-runtime.facts.js";
import {
  createPreparedModelRuntimeSnapshot,
  prepareFullCatalogFacts,
} from "./prepared-model-runtime.full-catalog.js";
import {
  createPreparedInboundRegistryLoader,
  preparedModelRuntimeWorkspaceFactsKey,
} from "./prepared-model-runtime.inbound-registry.js";
import { registerPreparedModelRuntimeClose } from "./prepared-model-runtime.lifecycle.js";
import {
  discardPreparedPluginGeneration,
  registerPreparedPluginLifetime,
  retainPreparedPluginRegistry,
} from "./prepared-model-runtime.plugin-lifetime.js";
import { PreparedModelRuntimeBuildResources } from "./prepared-model-runtime.resources.js";
import { prepareAgentCatalogSource } from "./prepared-model-runtime.scoped-catalog.js";
import type {
  PreparedModelRuntimeBuildStats,
  PreparedModelRuntimeCatalogMode,
  PreparedModelRuntimeInput,
  PreparedModelRuntimePluginGeneration,
  PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.types.js";

const MAX_CONCURRENT_MODEL_RUNTIME_AGENT_SOURCE_BUILDS = 2;

export type PreparedModelRuntimeBuildCandidate = Readonly<{
  input: PreparedModelRuntimeInput;
  catalogOwner: PreparedModelRuntimeSnapshot["catalogOwner"];
  inventoryOwner?: Parameters<typeof createFullModelCatalogAccess>[0]["inventoryOwner"];
  pluginGeneration?: PreparedModelRuntimePluginGeneration;
  prepareInboundPluginRegistry?: boolean;
  isGenerationCurrent?: () => boolean;
  isBuildCurrent?: () => boolean;
  onBeforeAuthCapture?: () => void;
  inspectRegistry?: boolean;
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
  requestedCandidates: readonly PreparedModelRuntimeBuildCandidate[],
  registryResources: PreparedModelRuntimeBuildResources,
  catalogMode: PreparedModelRuntimeCatalogMode,
  pluginMetadataSnapshot?: PreparedModelRuntimePluginGeneration["pluginMetadataSnapshot"],
  onBuildStats?: (stats: PreparedModelRuntimeBuildStats) => void,
  includeCredentialProviders = catalogMode === "live",
  onStage?: (stage: string) => void,
  onPrepared?: (input: PreparedModelRuntimeInput, result: PreparedModelRuntimeBuildResult) => void,
  signal?: AbortSignal,
): Promise<PreparedModelRuntimeBuildResult[]> {
  const configs = new Map<
    OpenClawConfig,
    { config: OpenClawConfig; nativeConfigFingerprint: string }
  >();
  const candidates = requestedCandidates.map((candidate) => {
    const source = candidate.input.config;
    let shared = configs.get(source);
    if (!shared) {
      const config = captureRuntimeConfig(source);
      shared = {
        config,
        nativeConfigFingerprint: fingerprintPreparedRuntimeFacts({
          agents: config.agents,
          plugins: config.plugins,
        }),
      };
      configs.set(source, shared);
    }
    return {
      ...candidate,
      input: { ...candidate.input, config: shared.config },
      nativeConfigFingerprint: shared.nativeConfigFingerprint,
    };
  });
  const candidateByInput = new Map(candidates.map((candidate) => [candidate.input, candidate]));
  const requestedByInput = new Map(
    candidates.map((candidate, index) => [candidate.input, requestedCandidates[index]!.input]),
  );
  const results = new Map<PreparedModelRuntimeInput, PreparedModelRuntimeBuildResult>();
  const prepareSnapshot = (
    candidate: PreparedModelRuntimeBuildCandidate,
    agentFacts: PreparedModelRuntimeAgentFacts,
    pluginGeneration: PreparedModelRuntimePluginGeneration,
    catalogFacts: PreparedModelRuntimeCatalogFacts,
  ) => {
    const snapshot = createPreparedModelRuntimeSnapshot(
      candidate.catalogOwner,
      agentFacts,
      pluginGeneration,
      catalogFacts,
      createFullModelCatalogAccess({
        agentFacts,
        nativeConfigFingerprint: candidateByInput.get(candidate.input)!.nativeConfigFingerprint,
        catalogFacts,
        pluginGeneration,
        isCurrent: candidate.isGenerationCurrent ?? (() => false),
        inventoryOwner: candidate.inventoryOwner ?? {},
      }),
      requestedByInput.get(candidate.input)!.config,
    );
    const result = { snapshot, pluginGeneration };
    results.set(candidate.input, result);
    onPrepared?.(requestedByInput.get(candidate.input)!, result);
  };
  const assertBuildCurrent = (input: PreparedModelRuntimeInput) =>
    assertPreparedModelRuntimeInputCurrent(input, candidateByInput.get(input)!.isBuildCurrent);
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
          if (candidate.inspectRegistry) {
            return `inspection\0${workspace}`;
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
    const configuredModelRegistries: PreparedConfiguredModelRegistries = new Map();
    // Config objects can change between publications. Share this projection only
    // inside the current build batch so every later publication reads fresh config.
    const configuredHarnessRuntimesByConfig = new Map<OpenClawConfig, readonly string[]>();
    const configuredModelFactsByConfig = new Map<
      OpenClawConfig,
      Map<
        PreparedModelRuntimePluginGeneration["pluginMetadataSnapshot"],
        ReturnType<typeof prepareConfiguredModelFacts>
      >
    >();
    const getConfiguredModelFacts: typeof prepareConfiguredModelFacts = (config, metadata) => {
      let factsByMetadata = configuredModelFactsByConfig.get(config);
      if (!factsByMetadata) {
        factsByMetadata = new Map();
        configuredModelFactsByConfig.set(config, factsByMetadata);
      }
      let facts = factsByMetadata.get(metadata);
      if (!facts) {
        facts = prepareConfiguredModelFacts(config, metadata);
        factsByMetadata.set(metadata, facts);
      }
      return facts;
    };
    let runtimePluginMs = 0;
    let pluginMetadataMs = 0;
    let staticProviderCatalogMs = 0;
    let ambientCredentialsMs = 0;
    let agentFactsMs = 0;
    let configuredProjectionMs = 0;
    let runtimeRegistryCount = 0;
    let registryMs = 0;
    const preparedCatalogs = new Map<PreparedModelRuntimeInput, PreparedModelRuntimeCatalogFacts>();
    const workspaceFactsStartedAt = performance.now();
    // Workspace plugin loading and static hooks are intentionally sequential. Large parallel
    // workspace fanout recreates the CPU/RSS spike this generation boundary is meant to contain.
    for (const { groupCandidates, pluginGeneration } of groups) {
      // Already-resolved promises do not let timers or Gateway I/O run.
      await nextTurn();
      for (const candidate of groupCandidates) {
        assertBuildCurrent(candidate.input);
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
          getConfiguredModelFacts,
          assertCurrent: assertBuildCurrent,
          onBeforeAuthCapture: (input) => candidateByInput.get(input)!.onBeforeAuthCapture?.(),
          onStage,
          signal,
          registryResources,
          ...(groupCandidates.some((candidate) => candidate.inspectRegistry)
            ? { loadRuntimeRegistry: registryResources.load.bind(registryResources) }
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
      if (catalogMode === "static") {
        const startedAt = performance.now();
        const batch = await prepareConfiguredRuntimeFactsBatch({
          agentFacts: prepared.agentFacts,
          pluginGeneration: prepared.pluginGeneration,
          assertCurrent: assertBuildCurrent,
          registries: configuredModelRegistries,
        });
        runtimeRegistryCount += batch.registryCount;
        registryMs += performance.now() - startedAt;
        for (const candidate of groupCandidates) {
          await nextTurn();
          assertBuildCurrent(candidate.input);
          const facts = batch.catalogs.get(candidate.input)!;
          preparedCatalogs.set(candidate.input, facts);
          prepareSnapshot(
            candidate,
            requirePreparedInput(candidate.input).agentFacts,
            prepared.pluginGeneration,
            facts,
          );
        }
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
            await nextTurn();
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
    const registryStartedAt = performance.now();
    onStage?.("model registries");
    if (catalogMode === "live") {
      // Explicit live owners still request the complete inventory. Keep those builds sequential
      // instead of multiplying heap and GC pressure when a command names several agents.
      for (const candidate of candidates) {
        await nextTurn();
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
    }
    registryMs += performance.now() - registryStartedAt;
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
    for (const candidate of candidates) {
      if (results.has(candidate.input)) {
        continue;
      }
      await nextTurn();
      const { input } = candidate;
      assertBuildCurrent(input);
      const { agentFacts, pluginGeneration } = requirePreparedInput(input);
      const catalogFacts = preparedCatalogs.get(input);
      if (!catalogFacts) {
        throw new Error(`prepared model runtime snapshot facts missing for ${input.agentDir}`);
      }
      prepareSnapshot(candidate, agentFacts, pluginGeneration, catalogFacts);
    }
    assertPreparedModelRuntimeCandidatesCurrent(candidates);
    return candidates.map(({ input }) => results.get(input)!);
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
  buildTimeoutMs: number | undefined,
  catalogMode: PreparedModelRuntimeCatalogMode = "live",
  onBuildStats?: (stats: PreparedModelRuntimeBuildStats) => void,
  pluginMetadataSnapshot?: PreparedModelRuntimePluginGeneration["pluginMetadataSnapshot"],
  includeCredentialProviders = catalogMode === "live",
  progress?: {
    onStage: (stage: string) => void;
    onPrepared: (input: PreparedModelRuntimeInput, result: PreparedModelRuntimeBuildResult) => void;
  },
  acquisitionSignal?: AbortSignal,
): {
  pending: Promise<PreparedModelRuntimeBuildResult[]>;
  completion: Promise<void>;
} {
  const cancellation = new AbortController();
  const signal = acquisitionSignal
    ? AbortSignal.any([acquisitionSignal, cancellation.signal])
    : cancellation.signal;
  const finished = createDeferredCore();
  const unregisterClose = registerPreparedModelRuntimeClose(async (error) => {
    cancellation.abort(error);
    await finished.promise;
  });
  const agentDirs = [...new Set(candidates.map(({ input }) => input.agentDir))];
  let stage = "previous generation completion";
  const previousBuildCompletions = agentDirs
    .map((agentDir) => agentBuildCompletions.get(agentDir))
    .filter((completion) => completion !== undefined);
  const agentCompletions = progress
    ? new Map(agentDirs.map((agentDir) => [agentDir, createDeferredCore()]))
    : undefined;
  const remainingByAgent = new Map(
    agentDirs.map((agentDir) => [
      agentDir,
      candidates.filter(({ input }) => input.agentDir === agentDir).length,
    ]),
  );
  // Lifecycle events may overlap. The timeout covers queueing plus this build, while completion
  // follows the real work so a timed-out generation can never overlap a replacement.
  const startBuild = (async () => {
    // Register before waiting: shutdown also owns resources from unfinished builds.
    registerPreparedPluginLifetime();
    await using registryResources = new PreparedModelRuntimeBuildResources(
      retainPreparedPluginRegistry,
    );
    if (previousBuildCompletions.length > 0) {
      await Promise.all(previousBuildCompletions);
      // Queued publications register while the prior build settles. Recheck them here so a
      // retired owner cannot start expensive workspace preparation ahead of its replacement.
      assertPreparedModelRuntimeCandidatesCurrent(candidates);
    }
    signal.throwIfAborted();
    return await buildSnapshotBatch(
      candidates,
      registryResources,
      catalogMode,
      pluginMetadataSnapshot,
      onBuildStats,
      includeCredentialProviders,
      (nextStage) => {
        stage = nextStage;
        progress?.onStage(nextStage);
      },
      progress
        ? (input, result) => {
            progress.onPrepared(input, result);
            const remaining = remainingByAgent.get(input.agentDir)! - 1;
            remainingByAgent.set(input.agentDir, remaining);
            if (remaining === 0) {
              // This directory has no remaining writes; another workspace must not hold its auth refresh.
              agentCompletions!.get(input.agentDir)!.resolve();
            }
          }
        : undefined,
      signal,
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
    const agentCompletion = agentCompletions?.get(agentDir);
    if (agentCompletion) {
      void completion.then(() => agentCompletion.resolve());
    }
    const ownedCompletion = agentCompletion?.promise ?? completion;
    agentBuildCompletions.set(agentDir, ownedCompletion);
    void ownedCompletion.then(() => {
      if (agentBuildCompletions.get(agentDir) === ownedCompletion) {
        agentBuildCompletions.delete(agentDir);
      }
    });
  }
  void completion.then(() => {
    unregisterClose();
    finished.resolve();
  });
  return { pending, completion };
}
