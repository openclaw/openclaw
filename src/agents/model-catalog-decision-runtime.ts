import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { stripSelfProviderModelPrefix } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import {
  createModelProviderRouteOverrideResolver,
  resolveMergedModelProviderConfig,
} from "../config/model-provider-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { createProviderModelRoutesResolver } from "../plugins/provider-model-routes.js";
import { resolveProviderRefOwnership } from "../plugins/providers.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  withCurrentReadAuthority,
  type CurrentReadAuthority,
} from "../shared/current-read-authority.js";
import type { GatewayAgentRuntime } from "../shared/session-types.js";
import { isDefaultAgentRuntimeId, normalizeOptionalAgentRuntimeId } from "./agent-runtime-id.js";
import type { listCliRuntimeModelBackendBindings } from "./cli-backends.js";
import { resolveAgentHarnessAutoSelectionHint } from "./harness/auto-selection.js";
import { resolveAgentHarnessAvailabilityDecision } from "./harness/availability.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import { getRegisteredAgentHarness, listRegisteredAgentHarnesses } from "./harness/registry.js";
import { resolveAgentHarnessSupport } from "./harness/route-support.js";
import {
  buildAgentHarnessSupportContext,
  resolveAutoAgentHarnessId,
  resolveAutoAgentHarnessSelection,
} from "./harness/support.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import type { createModelCatalogSnapshotView } from "./model-catalog-view.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { hasAuthoredProviderRequestParams } from "./model-extra-params.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import type { AgentRuntimePolicyScope } from "./model-runtime-policy.js";

function finalizeSelectedDecisionRuntime(
  policy: ReturnType<typeof resolveAgentHarnessPolicy>,
  evaluation: ModelAuthAvailabilityEvaluation,
  selectedRuntime: string,
): GatewayAgentRuntime | undefined {
  // Route projection must retain the native owner that supplied availability. Recomputing
  // implicit policy from its API-key route alone would relabel that owner as OpenClaw.
  const runtime =
    policy.runtimeSource === "implicit" &&
    !policy.forcedByEnvironment &&
    isDefaultAgentRuntimeId(evaluation.requestedRuntimeId)
      ? (evaluation.runtimeAuth?.id ?? selectedRuntime)
      : selectedRuntime;
  if (policy.runtime === "auto" && runtime === "openclaw" && !evaluation.requestedRuntimeId) {
    return undefined;
  }
  return { id: runtime, source: policy.runtimeSource ?? "implicit" };
}

/** Public runtime and thinking consume this same route/account decision. */
export function resolveCatalogDecisionRuntime(
  params: {
    cfg: OpenClawConfig;
    entry: ModelCatalogEntry;
    evaluation: ModelAuthAvailabilityEvaluation;
    pluginRegistry?: PluginRegistry;
    resolveOpenAIProviderRoutes?: Parameters<
      typeof resolveAgentHarnessPolicy
    >[0]["resolveOpenAIProviderRoutes"];
  } & AgentRuntimePolicyScope,
): GatewayAgentRuntime | undefined {
  const route = params.evaluation.selectedRoute;
  const context = {
    config: params.cfg,
    ...(params.agentScope ? { agentScope: params.agentScope } : { agentId: params.agentId }),
    provider: params.entry.provider,
    modelId: params.entry.id,
    modelProvider: {
      api: route?.api ?? params.entry.api,
      baseUrl: route?.baseUrl ?? params.entry.baseUrl,
      requestTransportOverrides: route?.requestTransportOverrides,
      runtimePolicy: route?.runtimePolicy,
      preparedAuth: params.evaluation.selectedCredential,
    },
    preparedModelProvider: true,
    resolveOpenAIProviderRoutes: params.resolveOpenAIProviderRoutes,
  };
  const select = () => {
    const { policy } = resolveAgentHarnessAvailabilityDecision({
      ...context,
      mode: "projection",
      agentHarnessRuntimeOverride: params.evaluation.requestedRuntimeId,
    });
    return {
      policy,
      runtime:
        policy.runtime === "auto"
          ? (resolveAutoAgentHarnessId(context) ?? "openclaw")
          : policy.runtime,
    };
  };
  const selected = params.pluginRegistry
    ? withPluginRuntimeRegistryScope(params.pluginRegistry, select)
    : (() => {
        const policy = resolveAgentHarnessPolicy({
          ...context,
          modelApi: context.modelProvider.api,
          modelBaseUrl: context.modelProvider.baseUrl,
          requestTransportOverrides: context.modelProvider.requestTransportOverrides,
        });
        return {
          policy,
          runtime:
            params.evaluation.requestedRuntimeId ??
            (policy.runtime === "auto" ? "openclaw" : policy.runtime),
        };
      })();
  return finalizeSelectedDecisionRuntime(selected.policy, params.evaluation, selected.runtime);
}

/** Caches the static native-policy inputs for one prepared catalog view. */
export function createCatalogNativePolicyPreparer(params: {
  cfg: OpenClawConfig;
  agentId: string;
  preferredProfileId?: string;
  pinnedProfileId?: string;
  profileProvider?: string;
  resolveOpenAIProviderRoutes?: ReturnType<typeof createProviderModelRoutesResolver>;
  implicitNativeRuntime: (entry: ModelCatalogEntry) => string | undefined;
}) {
  let preparedOpenAIProviderRoutes = params.resolveOpenAIProviderRoutes;
  const runtimePolicies = new WeakMap<
    ModelCatalogEntry,
    { policy: ReturnType<typeof resolveAgentHarnessPolicy>; hostConfigured?: boolean }
  >();
  const getRuntimePolicy = (entry: ModelCatalogEntry) => {
    let prepared = runtimePolicies.get(entry);
    if (!prepared) {
      let policy = resolveAgentHarnessPolicy({
        provider: entry.provider,
        modelId: entry.id,
        modelApi: entry.api,
        modelBaseUrl: entry.baseUrl,
        config: params.cfg,
        agentScope: { kind: "prepared", agentId: params.agentId },
        resolveOpenAIProviderRoutes: (observed) =>
          (preparedOpenAIProviderRoutes ??= createProviderModelRoutesResolver({
            provider: "openai",
            config: params.cfg,
          }))(observed),
      });
      if (
        !policy.forcedByEnvironment &&
        policy.runtimeSource === "implicit" &&
        policy.runtime === "auto"
      ) {
        policy = { ...policy, runtime: params.implicitNativeRuntime(entry) ?? policy.runtime };
      }
      prepared = { policy };
      runtimePolicies.set(entry, prepared);
    }
    return prepared;
  };
  const providers = new Map<
    string,
    {
      configured: ReturnType<typeof resolveMergedModelProviderConfig>;
      modelKeys: Set<string>;
      resolveOverride: ReturnType<typeof createModelProviderRouteOverrideResolver>;
    }
  >();
  const prepareHostConfiguration = (
    entry: ModelCatalogEntry,
    provider: string,
    prepared: ReturnType<typeof getRuntimePolicy>,
  ) => {
    if (prepared.hostConfigured !== undefined) {
      return;
    }
    const modelKey = (id: string) =>
      stripSelfProviderModelPrefix(provider, splitTrailingAuthProfile(id).model.trim()).trim();
    let facts = providers.get(provider);
    if (!facts) {
      const configured = resolveMergedModelProviderConfig(params.cfg, provider);
      facts = {
        configured,
        modelKeys: new Set(
          configured?.models
            ?.filter((model) => model.api || model.baseUrl)
            .map(({ id }) => modelKey(id)),
        ),
        resolveOverride: createModelProviderRouteOverrideResolver({
          authoredConfig: params.cfg,
          provider,
        }),
      };
      providers.set(provider, facts);
    }
    const { configured, modelKeys, resolveOverride } = facts;
    const sameProvider =
      !params.profileProvider || normalizeProviderId(params.profileProvider) === provider;
    prepared.hostConfigured = Boolean(
      (sameProvider && params.preferredProfileId) ||
      (sameProvider && params.pinnedProfileId) ||
      configured?.api ||
      configured?.baseUrl ||
      configured?.apiKey ||
      configured?.auth ||
      modelKeys.has(modelKey(entry.id)) ||
      Object.keys(params.cfg.auth?.order ?? {}).some(
        (id) => normalizeProviderId(id) === provider,
      ) ||
      Object.values(params.cfg.auth?.profiles ?? {}).some(
        (profile) => normalizeProviderId(profile.provider) === provider,
      ) ||
      resolveOverride(entry.id) === "present" ||
      hasAuthoredProviderRequestParams({
        config: params.cfg,
        provider,
        modelId: entry.id,
        agentId: params.agentId,
      }),
    );
  };
  function prepareNativePolicy(
    entry: ModelCatalogEntry,
    host?: ModelAuthAvailabilityEvaluation,
    runtimeId?: string,
  ): void {
    const prepared = getRuntimePolicy(entry);
    const runtime = runtimeId ?? host?.requestedRuntimeId ?? prepared.policy.runtime;
    if (runtime === "auto" || runtime === "openclaw") {
      return;
    }
    prepareHostConfiguration(entry, normalizeProviderId(entry.provider), prepared);
  }
  return { getRuntimePolicy, prepareHostConfiguration, prepareNativePolicy };
}

type CatalogEntryEvaluator = (
  entry: ModelCatalogEntry,
  variants?: readonly ModelCatalogEntry[],
  runtimeId?: string,
) => ModelAuthAvailabilityEvaluation;
type CatalogNativePolicyPreparer = (
  entry: ModelCatalogEntry,
  host?: ModelAuthAvailabilityEvaluation,
  runtimeId?: string,
) => void;

/** Reuses route policy and support inputs while checking live harness support on reads. */
export function createCatalogDecisionRuntimeResolver(params: {
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  metadataSnapshot: PluginMetadataSnapshot;
  pluginRegistry?: PluginRegistry;
  cliRuntimeBindings: ReturnType<typeof listCliRuntimeModelBackendBindings>;
  resolveOpenAIProviderRoutes: ReturnType<typeof createProviderModelRoutesResolver>;
  evaluateEntry: CatalogEntryEvaluator;
  evaluateNative: (
    entry: ModelCatalogEntry,
    host: ModelAuthAvailabilityEvaluation,
    runtimeId?: string,
  ) => ModelAuthAvailabilityEvaluation;
  prepareNativePolicy: CatalogNativePolicyPreparer;
}) {
  const {
    workspaceDir,
    metadataSnapshot,
    pluginRegistry,
    cliRuntimeBindings,
    resolveOpenAIProviderRoutes,
    evaluateEntry,
    evaluateNative,
    prepareNativePolicy,
  } = params;
  const harnessPolicies = new Map<string, ReturnType<typeof resolveAgentHarnessPolicy>>();
  const supportContexts = new Map<string, ReturnType<typeof buildAgentHarnessSupportContext>>();
  const providerOwnerships = new Map<string, ReturnType<typeof resolveProviderRefOwnership>>();
  const ownerScope = { agentId: params.agentId };
  const scopeKey = (scope: AgentRuntimePolicyScope) =>
    JSON.stringify(scope.agentScope ?? scope.agentId);
  const modelProvider = (entry: ModelCatalogEntry, evaluation: ModelAuthAvailabilityEvaluation) => {
    const route = evaluation.selectedRoute;
    return {
      api: route?.api ?? entry.api,
      baseUrl: route?.baseUrl ?? entry.baseUrl,
      requestTransportOverrides: route?.requestTransportOverrides,
      runtimePolicy: route?.runtimePolicy,
      preparedAuth: evaluation.selectedCredential,
    };
  };
  const harnessPolicy = (
    entry: ModelCatalogEntry,
    provider: ReturnType<typeof modelProvider>,
    scope: AgentRuntimePolicyScope = ownerScope,
  ) => {
    const key = [
      entry.provider,
      entry.id,
      scopeKey(scope),
      provider.api,
      provider.baseUrl,
      provider.requestTransportOverrides,
    ].join("\0");
    let policy = harnessPolicies.get(key);
    if (!policy) {
      policy = resolveAgentHarnessPolicy({
        config: params.cfg,
        ...scope,
        provider: entry.provider,
        modelId: entry.id,
        modelApi: provider.api,
        modelBaseUrl: provider.baseUrl,
        requestTransportOverrides: provider.requestTransportOverrides,
        resolveOpenAIProviderRoutes,
      });
      harnessPolicies.set(key, policy);
    }
    return policy;
  };
  const providerOwnership = (provider: string) => {
    const key = normalizeProviderId(provider);
    let ownership = providerOwnerships.get(key);
    if (!ownership) {
      ownership = resolveProviderRefOwnership({
        provider,
        config: params.cfg,
        workspaceDir,
        metadataSnapshot,
      });
      providerOwnerships.set(key, ownership);
    }
    return ownership;
  };
  const supportContext = (
    entry: ModelCatalogEntry,
    requestedRuntime: string,
    provider: ReturnType<typeof modelProvider>,
    options: Pick<
      Parameters<typeof buildAgentHarnessSupportContext>[0],
      "contextManagement" | "preparedModelProvider" | "providerOwnership"
    >,
    scope: AgentRuntimePolicyScope = ownerScope,
    providerName = entry.provider,
  ) => {
    const key = [
      entry.provider,
      entry.id,
      scopeKey(scope),
      requestedRuntime,
      options.contextManagement,
      providerName,
      options.preparedModelProvider ? "1" : "0",
      JSON.stringify(options.providerOwnership),
      provider.api,
      provider.baseUrl,
      provider.requestTransportOverrides,
      JSON.stringify(provider.runtimePolicy),
      JSON.stringify(provider.preparedAuth),
    ].join("\0");
    let context = supportContexts.get(key);
    if (!context) {
      context = buildAgentHarnessSupportContext({
        config: params.cfg,
        ...scope,
        ...options,
        provider: providerName,
        modelId: entry.id,
        requestedRuntime,
        modelProvider: provider,
      });
      supportContexts.set(key, context);
    }
    return context;
  };
  const resolveDecisionRuntime = (
    entry: ModelCatalogEntry,
    evaluation: ModelAuthAvailabilityEvaluation,
    scope: AgentRuntimePolicyScope = ownerScope,
    prepareOnly = false,
  ) => {
    const provider = modelProvider(entry, evaluation);
    const configured = harnessPolicy(entry, provider, scope);
    if (!pluginRegistry) {
      const selectedRuntime =
        evaluation.requestedRuntimeId ??
        (configured.runtime === "auto" ? "openclaw" : configured.runtime);
      return finalizeSelectedDecisionRuntime(configured, evaluation, selectedRuntime);
    }
    const override = normalizeOptionalAgentRuntimeId(evaluation.requestedRuntimeId);
    const policy =
      override && !isDefaultAgentRuntimeId(override)
        ? { ...configured, runtime: override, runtimeSource: "model" as const }
        : configured;
    const select = (registry: PluginRegistry) =>
      withPluginRuntimeRegistryScope(registry, () => {
        if (policy.runtime === "auto") {
          const providerId = entry.provider;
          const harnesses = listRegisteredAgentHarnesses().map(({ harness }) => harness);
          const getContext = () =>
            supportContext(entry, "auto", provider, { preparedModelProvider: true }, scope);
          if (prepareOnly) {
            if (
              harnesses.some(
                (harness) =>
                  !resolveAgentHarnessAutoSelectionHint({ harness, provider: providerId }),
              )
            ) {
              getContext();
            }
            return "openclaw";
          }
          const auto = resolveAutoAgentHarnessSelection(harnesses, providerId, getContext, true);
          return auto.selected?.id ?? "openclaw";
        }
        const registered = getRegisteredAgentHarness(policy.runtime);
        if (registered) {
          // Catalog rows have a finalized provider, and carry no pinned transcript harness.
          const context = supportContext(
            entry,
            policy.runtime,
            provider,
            {
              contextManagement: registered.harness.contextManagement,
              preparedModelProvider: true,
            },
            scope,
            entry.provider.trim(),
          );
          if (!prepareOnly) {
            const support = resolveAgentHarnessSupport(registered.harness, context, true);
            const implicit = policy.runtime === "codex" && policy.runtimeSource === "implicit";
            if (
              !support.supported &&
              !policy.forcedByEnvironment &&
              (implicit || support.fallbackRuntime === "openclaw")
            ) {
              return "openclaw";
            }
          }
        }
        return policy.runtime;
      });
    // An empty owner registry gives auto selection no candidates.
    const selectedRuntime =
      policy.runtime === "openclaw" ||
      (policy.runtime === "auto" && pluginRegistry.agentHarnesses.length === 0)
        ? "openclaw"
        : select(pluginRegistry);
    return finalizeSelectedDecisionRuntime(policy, evaluation, selectedRuntime);
  };
  const prepareDecisionRuntime = (
    entry: ModelCatalogEntry,
    host: ModelAuthAvailabilityEvaluation,
  ) => resolveDecisionRuntime(entry, host, ownerScope, true);
  const applicableCliBindings = (entry: ModelCatalogEntry) =>
    cliRuntimeBindings.filter(
      (binding) => normalizeProviderId(binding.provider) === normalizeProviderId(entry.provider),
    );
  const candidateRuntimes = (
    entry: ModelCatalogEntry,
    variants: readonly ModelCatalogEntry[],
    initial: ModelAuthAvailabilityEvaluation,
    selectedRuntime: string,
  ) =>
    new Set([
      selectedRuntime,
      "openclaw",
      ...(pluginRegistry?.agentHarnesses.map(({ harness }) => harness.id) ?? []),
      ...variants.flatMap((variant) => (variant.nativeRuntime ? [variant.nativeRuntime] : [])),
      ...(initial.routeResolution?.kind === "routes"
        ? initial.routeResolution.routes.flatMap(
            (route) => route.runtimePolicy?.compatibleIds ?? [],
          )
        : []),
      ...applicableCliBindings(entry).map((binding) => binding.runtime),
    ]);
  const needsChoiceHarness = (entry: ModelCatalogEntry, runtimeId: string) =>
    runtimeId !== "openclaw" &&
    !applicableCliBindings(entry).some((binding) => binding.runtime === runtimeId);
  const choiceHarness = (runtimeId: string) =>
    pluginRegistry?.agentHarnesses.find(({ harness }) => harness.id === runtimeId)?.harness;
  const allowsRuntime = (
    entry: ModelCatalogEntry,
    evaluation: ModelAuthAvailabilityEvaluation,
    runtimeId: string,
  ) => {
    const policy = harnessPolicy(entry, modelProvider(entry, evaluation));
    const compatible = evaluation.selectedRoute?.runtimePolicy?.compatibleIds;
    return (
      (!policy.forcedByEnvironment || policy.runtime === runtimeId) &&
      (!compatible || compatible.includes(runtimeId)) &&
      (!evaluation.runtimeAuth || evaluation.runtimeAuth.id === runtimeId)
    );
  };
  const prepareRuntimeChoices = (
    entry: ModelCatalogEntry,
    variants: readonly ModelCatalogEntry[],
  ) => {
    const initial = evaluateEntry(entry, variants);
    const selected = prepareDecisionRuntime(entry, initial);
    for (const runtimeId of candidateRuntimes(
      entry,
      variants,
      initial,
      selected?.id ?? "openclaw",
    )) {
      const host = evaluateEntry(entry, variants, runtimeId);
      prepareNativePolicy(entry, host, runtimeId);
      const harness =
        allowsRuntime(entry, host, runtimeId) && needsChoiceHarness(entry, runtimeId)
          ? choiceHarness(runtimeId)
          : undefined;
      if (harness) {
        supportContext(entry, runtimeId, modelProvider(entry, host), {
          contextManagement: harness.contextManagement,
          providerOwnership: providerOwnership(entry.provider),
        });
      }
    }
  };

  function runtimeChoices(
    entry: ModelCatalogEntry,
    variants: readonly ModelCatalogEntry[] = [entry],
  ): string[] | undefined {
    const initial = evaluateEntry(entry, variants);
    const selected = resolveDecisionRuntime(entry, initial);
    const candidates = candidateRuntimes(entry, variants, initial, selected?.id ?? "openclaw");
    const choices: string[] = [];
    let unknown = false;
    for (const runtimeId of candidates) {
      const host = evaluateEntry(entry, variants, runtimeId);
      const evaluation = evaluateNative(entry, host, runtimeId);
      if (evaluation.availability === undefined) {
        unknown = true;
      }
      if (evaluation.availability !== true || !allowsRuntime(entry, evaluation, runtimeId)) {
        continue;
      }
      if (needsChoiceHarness(entry, runtimeId)) {
        const harness = choiceHarness(runtimeId);
        if (!harness) {
          unknown ||= pluginRegistry === undefined;
          continue;
        }
        const supported = harness.supports(
          supportContext(entry, runtimeId, modelProvider(entry, evaluation), {
            contextManagement: harness.contextManagement,
            providerOwnership: providerOwnership(entry.provider),
          }),
        );
        if (!supported.supported) {
          continue;
        }
      }
      choices.push(runtimeId);
    }
    return choices.length === 0 && unknown ? undefined : choices;
  }
  return {
    prepareDecisionRuntime,
    resolveDecisionRuntime,
    prepareRuntimeChoices,
    runtimeChoices,
  };
}

export const CATALOG_SCAN_YIELD_BUDGET_MS = 8;

type CatalogSnapshotView = ReturnType<typeof createModelCatalogSnapshotView>;
type CatalogProjectionRow = { entry: ModelCatalogEntry; host: ModelAuthAvailabilityEvaluation };
type ProjectCatalogEntry<Result> = (
  view: CatalogSnapshotView,
  entry: ModelCatalogEntry,
  host: ModelAuthAvailabilityEvaluation,
) => Result;
export type CatalogProjection = { rows: ModelCatalogEntry[]; epoch: number; authValid: boolean };

/** Warms one account generation in slices, then projects live readiness in a single frame. */
export function createCatalogProjectionReader(params: {
  createView: () => CatalogSnapshotView;
  evaluateEntry: CatalogEntryEvaluator;
  prepareNativePolicy: CatalogNativePolicyPreparer;
  warmEntry: ProjectCatalogEntry<void>;
  projectEntry: ProjectCatalogEntry<ModelCatalogEntry>;
  hasAccountCatalogSelections: boolean;
  readEpoch: () => number;
  readPendingAccountPrep: () => Promise<void> | undefined;
  readProjection: () => CatalogProjection | undefined;
  publishProjection: (projection: CatalogProjection) => void;
  captureCurrent: (authority: CurrentReadAuthority | undefined) => {
    reassertCatalogScanCurrent: () => void;
    initiallyOwnerCurrent: boolean;
    initiallyAuthValid: boolean;
  };
}) {
  const { readEpoch, readPendingAccountPrep: readPending } = params;
  const { evaluateEntry, prepareNativePolicy, readProjection, publishProjection } = params;
  return async function projectCatalog(
    authority?: CurrentReadAuthority,
    options?: { allowYield?: boolean },
  ) {
    const canYield =
      (options?.allowYield ?? true) &&
      !(authority?.withCurrent !== undefined && authority.assertCurrent === undefined);
    const assertPreWrapper = () => {
      if (!authority?.withCurrent) {
        authority?.assertCurrent?.();
      }
    };
    assertPreWrapper();
    if (authority !== undefined && params.hasAccountCatalogSelections && readEpoch() === 0) {
      // Session metadata starts this projection before its sibling registers account preparation.
      await Promise.resolve();
      assertPreWrapper();
    }
    for (let pending = readPending(); pending; pending = readPending()) {
      await pending;
      assertPreWrapper();
    }
    return await withCurrentReadAuthority(authority, async () => {
      const { reassertCatalogScanCurrent, initiallyOwnerCurrent, initiallyAuthValid } =
        params.captureCurrent(authority);
      let view: CatalogSnapshotView | undefined;
      for (;;) {
        reassertCatalogScanCurrent();
        const cached = readProjection();
        if (
          !readPending() &&
          cached &&
          readEpoch() === cached.epoch &&
          initiallyOwnerCurrent &&
          initiallyAuthValid === cached.authValid
        ) {
          return cached.rows;
        }
        const scanView = (view ??= params.createView());
        const startEpoch = readEpoch();
        let sliceStartMs = canYield ? performance.now() : 0;
        const prepared: CatalogProjectionRow[] = [];
        for (const entry of scanView.logicalEntries) {
          if (canYield && performance.now() - sliceStartMs >= CATALOG_SCAN_YIELD_BUDGET_MS) {
            await yieldToEventLoop();
            reassertCatalogScanCurrent();
            if (readEpoch() !== startEpoch) {
              break;
            }
            sliceStartMs = performance.now();
          }
          const routeVariants = scanView.variantsOf(entry) ?? [entry];
          const host = evaluateEntry(entry, routeVariants);
          prepareNativePolicy(entry, host);
          params.warmEntry(scanView, entry, host);
          prepared.push({ entry, host });
        }
        if (canYield) {
          for (let pending = readPending(); pending; pending = readPending()) {
            await pending;
            reassertCatalogScanCurrent();
          }
          if (readEpoch() !== startEpoch) {
            continue;
          }
        }
        reassertCatalogScanCurrent();
        // Read revocable native state and project the whole catalog in one synchronous frame.
        const projection = prepared.map(({ entry, host }) =>
          params.projectEntry(scanView, entry, host),
        );
        reassertCatalogScanCurrent();
        if (
          authority === undefined &&
          !readPending() &&
          readEpoch() === startEpoch &&
          initiallyOwnerCurrent
        ) {
          publishProjection({
            rows: projection,
            epoch: startEpoch,
            authValid: initiallyAuthValid,
          });
        }
        return projection;
      }
    });
  };
}
