import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { dedupeByKey } from "../../shared/dedupe-by-key.js";
import { normalizeOptionalAgentRuntimeId, isDefaultAgentRuntimeId } from "../agent-runtime-id.js";
import {
  resolveAgentEffectiveModelPrimary,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agent-scope.js";
import { resolveConfiguredModelEntries } from "../configured-model-entries.js";
import { DEFAULT_PROVIDER } from "../defaults.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../model-catalog.types.js";
import type { ModelRef } from "../model-ref-shared.js";
import {
  buildConfiguredModelCatalog,
  resolveModelRefFromString,
} from "../model-selection-shared.js";
import {
  createModelCatalogIdentityKeyResolver,
  resolveModelCatalogIdentityKey,
} from "../openai-model-routes.js";
import { collectPreparedModelRuntimeConfiguredRefs } from "../prepared-model-runtime.configured.js";
import type { PreparedModelRuntimeInput } from "../prepared-model-runtime.types.js";
import { resolveDefaultAgentWorkspaceDir } from "../workspace.js";
import { resolveAgentHarnessPolicy } from "./policy.js";
import { getRegisteredAgentHarness } from "./registry.js";

function normalizeRouteBaseUrl(value: string | undefined): string {
  if (!value) {
    return "";
  }
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url.toString();
  } catch {
    return value.trim();
  }
}

function routeVariantKey(entry: ModelCatalogEntry, identityKey: string): string {
  return [
    identityKey,
    entry.nativeRuntime ?? "",
    entry.api ?? "",
    normalizeRouteBaseUrl(entry.baseUrl),
  ].join("\0");
}

function mergeHarnessCompat(
  observed: ModelCatalogEntry["compat"],
  provider: ModelCatalogEntry["compat"],
): ModelCatalogEntry["compat"] {
  if (!observed && !provider) {
    return undefined;
  }
  const compat = { ...provider, ...observed };
  if (observed?.supportedReasoningEfforts?.length === 0) {
    return { ...compat, supportsReasoningEffort: false, supportedReasoningEfforts: [] };
  }
  const efforts = [
    ...new Set([
      ...(provider?.supportedReasoningEfforts ?? []),
      ...(observed?.supportedReasoningEfforts ?? []),
    ]),
  ];
  return efforts.length > 0
    ? { ...compat, supportsReasoningEffort: true, supportedReasoningEfforts: efforts }
    : compat;
}

function enrichHarnessRows(
  rows: readonly ModelCatalogEntry[],
  snapshot: ModelCatalogSnapshot,
): ModelCatalogEntry[] {
  const keyOf = createModelCatalogIdentityKeyResolver();
  const routeDonors = new Map<string, ModelCatalogEntry>();
  const identityDonors = new Map<string, ModelCatalogEntry>();
  let donorsPrepared = false;
  return rows.map((entry) => {
    // Native discovery owns these capabilities; host donors cannot invent its transport.
    if (entry.nativeRuntime) {
      return entry;
    }
    if (!donorsPrepared) {
      // First donor wins: live snapshot entries take precedence over static rows.
      for (const donor of [...snapshot.entries, ...(snapshot.staticEntries ?? [])]) {
        const identityKey = keyOf(donor);
        const routeKey = routeVariantKey(donor, identityKey);
        if (!routeDonors.has(routeKey)) {
          routeDonors.set(routeKey, donor);
        }
        if (!identityDonors.has(identityKey)) {
          identityDonors.set(identityKey, donor);
        }
      }
      donorsPrepared = true;
    }
    const identityKey = keyOf(entry);
    const donor =
      routeDonors.get(routeVariantKey(entry, identityKey)) ??
      (entry.api === undefined && entry.baseUrl === undefined
        ? identityDonors.get(identityKey)
        : undefined);
    if (!donor) {
      return entry;
    }
    const compat = mergeHarnessCompat(entry.compat, donor.compat);
    const mergedParams =
      donor.params || entry.params ? { ...donor.params, ...entry.params } : undefined;
    return {
      ...donor,
      ...entry,
      ...(mergedParams ? { params: mergedParams } : {}),
      ...(compat ? { compat } : {}),
    };
  });
}

export async function augmentModelCatalogWithAgentHarness(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  defaultProvider: string;
  defaultModel?: string;
  /** Concrete runtime already selected for a turn; omitted for configured inventory reads. */
  agentRuntime?: string;
  snapshot: ModelCatalogSnapshot;
  /** Current route and donor facts stay separate from retained raw inventory. */
  preparedSnapshot?: ModelCatalogSnapshot;
  /** Explicit inventory acquisition; ordinary thinking reads stay selected-harness-only. */
  includePickerRuntimes?: boolean;
  pluginRegistry?: PluginRegistry | null;
  isCurrent?: () => boolean;
  observationConfig?: OpenClawConfig;
  includesProvider?: (provider: string) => boolean;
  onDiscoveryStarted?: (provider: string) => void;
  onDiscoveryCompleted?: (rows: readonly ModelCatalogEntry[]) => void;
  onError?: (error: unknown, providers?: readonly string[]) => void;
}): Promise<ModelCatalogSnapshot> {
  const prepared = params.preparedSnapshot ?? params.snapshot;
  const runtimeProviders = new Map<string, Set<string>>();
  const addRuntime = (value: string, provider: string) => {
    const runtime = normalizeOptionalAgentRuntimeId(value);
    if (
      !runtime ||
      isDefaultAgentRuntimeId(runtime) ||
      runtime === "openclaw" ||
      (params.includesProvider && !params.includesProvider(provider))
    ) {
      return;
    }
    const providers = runtimeProviders.get(runtime) ?? new Set<string>();
    providers.add(provider);
    runtimeProviders.set(runtime, providers);
  };
  const rawDefaultModel = params.defaultModel?.trim();
  const ref = rawDefaultModel
    ? resolveModelRefFromString({
        cfg: params.cfg,
        raw: rawDefaultModel,
        defaultProvider: params.defaultProvider,
        allowManifestNormalization: true,
        allowPluginNormalization: true,
      })?.ref
    : undefined;
  let defaultRuntime: string | undefined;
  if (ref) {
    const routeKeyOf = createModelCatalogIdentityKeyResolver();
    const refKey = routeKeyOf({ provider: ref.provider, id: ref.model });
    const routeEntry = [...prepared.entries, ...(prepared.staticEntries ?? [])].find(
      (entry) => routeKeyOf(entry) === refKey,
    );
    defaultRuntime =
      params.agentRuntime ??
      resolveAgentHarnessPolicy({
        provider: ref.provider,
        modelId: ref.model,
        modelApi: routeEntry?.api,
        modelBaseUrl: routeEntry?.baseUrl,
        config: params.cfg,
        agentId: params.agentId,
      }).runtime;
    addRuntime(defaultRuntime, ref.provider);
  }
  if (params.includePickerRuntimes) {
    for (const entry of resolveConfiguredModelEntries({
      cfg: params.cfg,
      agentId: params.agentId,
      defaultProvider: params.defaultProvider,
      defaultModel: params.defaultModel,
    }).entries) {
      for (const runtime of entry.pickerRuntimes ?? []) {
        addRuntime(runtime, entry.ref.provider);
      }
    }
  }
  if (runtimeProviders.size === 0) {
    return params.snapshot;
  }
  const pluginRegistry = params.observationConfig
    ? params.pluginRegistry
    : (params.pluginRegistry ?? getActivePluginRegistry());
  if (!pluginRegistry || params.isCurrent?.() === false) {
    return params.snapshot;
  }
  let configuredModelRefs: ModelRef[];
  try {
    configuredModelRefs = collectPreparedModelRuntimeConfiguredRefs(
      params.cfg,
      params.agentId,
    ).flatMap(({ value }) => {
      const resolved = resolveModelRefFromString({
        cfg: params.cfg,
        agentId: params.agentId,
        raw: value,
        defaultProvider: params.defaultProvider,
        allowManifestNormalization: true,
        allowPluginNormalization: true,
      })?.ref;
      return resolved ? [resolved] : [];
    });
  } catch (error) {
    params.onError?.(error);
    return params.snapshot;
  }
  const result = { ...params.snapshot };
  const completedRows: ModelCatalogEntry[] = [];
  let discovered = false;
  for (const [runtime, providers] of runtimeProviders) {
    // The scoped lookup retains transient catalog resources for executable CLI cleanup.
    const harness = withPluginRuntimeRegistryScope(
      pluginRegistry,
      () => getRegisteredAgentHarness(runtime)?.harness,
    );
    if (!harness?.loadModelCatalog) {
      continue;
    }
    if (params.isCurrent?.() === false) {
      return params.snapshot;
    }
    for (const provider of providers) {
      params.onDiscoveryStarted?.(provider);
    }
    let listedRows: readonly ModelCatalogEntry[];
    try {
      listedRows = await harness.loadModelCatalog({
        config: params.observationConfig ?? params.cfg,
        agentId: params.agentId,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        configuredModelRefs,
      });
    } catch (error) {
      if (
        params.isCurrent?.() === false ||
        (!params.pluginRegistry && getActivePluginRegistry() !== pluginRegistry)
      ) {
        return params.snapshot;
      }
      params.onError?.(error, [...providers]);
      continue;
    }
    if (
      params.isCurrent?.() === false ||
      (!params.pluginRegistry && getActivePluginRegistry() !== pluginRegistry)
    ) {
      return params.snapshot;
    }
    const includesProvider = params.includesProvider;
    const scopedRows = includesProvider
      ? listedRows.filter((entry) => includesProvider(entry.provider))
      : listedRows;
    completedRows.push(...scopedRows);
    discovered = true;
    const rows = enrichHarnessRows(scopedRows, prepared);
    // Discovery can replace the policy owner.
    const keyOf = createModelCatalogIdentityKeyResolver();
    const configuredKeys = new Set([
      ...configuredModelRefs.map(({ provider, model }) => keyOf({ provider, id: model })),
      ...buildConfiguredModelCatalog({
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
      }).map(keyOf),
    ]);
    // Successful discovery replaces its native scope; authored membership survives an empty list.
    // The scope predicate can change owners between rows, so retention keeps identity live.
    const retain = (entry: ModelCatalogEntry) =>
      entry.nativeRuntime !== runtime ||
      configuredKeys.has(resolveModelCatalogIdentityKey(entry)) ||
      (includesProvider !== undefined && !includesProvider(entry.provider));
    const retainedEntries = result.entries.filter(retain);
    // An optional native inventory must not replace the configured base's logical row.
    result.entries = dedupeByKey(
      runtime === defaultRuntime ? [...rows, ...retainedEntries] : [...retainedEntries, ...rows],
      createModelCatalogIdentityKeyResolver(),
    );
    const variantKeyOf = createModelCatalogIdentityKeyResolver();
    result.routeVariants = dedupeByKey([...rows, ...result.routeVariants.filter(retain)], (entry) =>
      routeVariantKey(entry, variantKeyOf(entry)),
    );
  }
  if (
    params.isCurrent?.() === false ||
    (!params.pluginRegistry && getActivePluginRegistry() !== pluginRegistry)
  ) {
    return params.snapshot;
  }
  if (discovered) {
    params.onDiscoveryCompleted?.(completedRows);
  }
  return discovered ? result : params.snapshot;
}

export function augmentPreparedModelCatalogWithAgentHarness(params: {
  input: PreparedModelRuntimeInput;
  snapshot: ModelCatalogSnapshot;
  preparedSnapshot?: ModelCatalogSnapshot;
  pluginRegistry?: PluginRegistry;
  isCurrent?: () => boolean;
  includesProvider?: (provider: string) => boolean;
  onDiscoveryStarted?: (provider: string) => void;
  onDiscoveryCompleted?: (rows: readonly ModelCatalogEntry[]) => void;
  onError?: (error: unknown, providers?: readonly string[]) => void;
}): Promise<ModelCatalogSnapshot> {
  const agentId = params.input.agentId ?? resolveDefaultAgentId(params.input.config);
  return augmentModelCatalogWithAgentHarness({
    cfg: params.input.config,
    agentId,
    agentDir: params.input.agentDir,
    workspaceDir:
      params.input.workspaceDir ??
      resolveAgentWorkspaceDir(params.input.config, agentId) ??
      resolveDefaultAgentWorkspaceDir(),
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: resolveAgentEffectiveModelPrimary(params.input.config, agentId),
    snapshot: params.snapshot,
    preparedSnapshot: params.preparedSnapshot,
    includePickerRuntimes: true,
    pluginRegistry: params.pluginRegistry,
    isCurrent: params.isCurrent,
    observationConfig: params.input.config,
    includesProvider: params.includesProvider,
    onDiscoveryStarted: params.onDiscoveryStarted,
    onDiscoveryCompleted: params.onDiscoveryCompleted,
    onError: params.onError,
  });
}
