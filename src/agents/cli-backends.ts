import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimeCliBackends } from "../plugins/cli-backends.runtime.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  resolvePluginSetupCliBackend,
  resolvePluginSetupRegistry,
} from "../plugins/setup-registry.js";
import { resolveRuntimeTextTransforms } from "../plugins/text-transforms.runtime.js";
import type { CliBackendNormalizeConfigContext, CliBackendPlugin } from "../plugins/types.js";
import { mergePluginTextTransforms } from "./plugin-text-transforms.js";

export type ResolvedCliBackend = Pick<
  CliBackendPlugin,
  | "id"
  | "modelProvider"
  | "config"
  | "bundleMcpMode"
  | "transformSystemPrompt"
  | "textTransforms"
  | "defaultAuthProfileId"
  | "authEpochMode"
  | "autoSelectAuthProfile"
  | "contextEngineHostCapabilities"
  | "ownsNativeCompaction"
  | "manualCompaction"
  | "prepareExecution"
  | "resolveExecutionArgs"
  | "resolveModelId"
  | "parseJsonlEvent"
  | "parseJsonlLifecycleEvent"
  | "toolAvailabilityEnforcement"
  | "projectNativeToolAuthority"
  | "nativeToolMode"
  | "hostOwnedTools"
  | "sideQuestionToolMode"
  | "runtimeArtifact"
> & {
  bundleMcp: boolean;
  pluginId?: string;
};

type ResolvedCliBackendLiveTest = {
  defaultModelRef?: string;
  defaultImageProbe: boolean;
  defaultMcpProbe: boolean;
  dockerNpmPackage?: string;
  dockerBinaryName?: string;
};

type CliRuntimeModelBackendBinding = {
  provider: string;
  runtime: string;
};

function resolveCliBackendModelProvider(
  backend: Pick<CliBackendPlugin, "modelProvider">,
): string | undefined {
  const provider = backend.modelProvider?.trim();
  return provider ? normalizeProviderId(provider) : undefined;
}

function addCliRuntimeModelBinding(
  bindings: Map<string, CliRuntimeModelBackendBinding>,
  backend: Pick<CliBackendPlugin, "id" | "modelProvider">,
): void {
  const provider = resolveCliBackendModelProvider(backend);
  const runtime = normalizeProviderId(backend.id);
  if (!provider || !runtime) {
    return;
  }
  bindings.set(`${provider}:${runtime}`, {
    provider,
    runtime,
  });
}

export function listCliRuntimeModelBackendBindings(
  params: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    includeSetupRegistry?: boolean;
  } = {},
): CliRuntimeModelBackendBinding[] {
  const bindings = new Map<string, CliRuntimeModelBackendBinding>();
  for (const backend of resolveRuntimeCliBackends("metadata")) {
    addCliRuntimeModelBinding(bindings, backend);
  }
  if (params.includeSetupRegistry === true) {
    for (const entry of resolvePluginSetupRegistry({
      config: params.config,
      env: params.env,
    }).cliBackends) {
      addCliRuntimeModelBinding(bindings, entry.backend);
    }
  }
  return [...bindings.values()].toSorted((left, right) =>
    left.provider === right.provider
      ? left.runtime.localeCompare(right.runtime)
      : left.provider.localeCompare(right.provider),
  );
}

export function listCliRuntimeProviderIds(
  params: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    includeSetupRegistry?: boolean;
  } = {},
): string[] {
  // Only CLI backends with a canonical modelProvider are runtime aliases that
  // should be hidden from model-provider pickers. Standalone CLI backends own
  // direct refs such as acme-cli/model and must remain selectable.
  return [
    ...new Set(listCliRuntimeModelBackendBindings(params).map((binding) => binding.runtime)),
  ].toSorted();
}

export function resolveCliRuntimeCanonicalProvider(params: {
  runtime: string | undefined;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  includeSetupRegistry?: boolean;
  metadataSnapshot?: PluginMetadataSnapshot | null;
}): string | undefined {
  const runtime = normalizeProviderId(params.runtime ?? "");
  if (!runtime) {
    return undefined;
  }
  const runtimeBinding = listCliRuntimeModelBackendBindings().find(
    (binding) => binding.runtime === runtime,
  );
  if (runtimeBinding) {
    return runtimeBinding.provider;
  }
  if (params.includeSetupRegistry !== true || params.metadataSnapshot === null) {
    return undefined;
  }
  const setupBackend = resolvePluginSetupCliBackend({
    backend: runtime,
    config: params.config,
    env: params.env,
    metadataSnapshot: params.metadataSnapshot,
  });
  return setupBackend ? resolveCliBackendModelProvider(setupBackend.backend) : undefined;
}

export function resolveCliRuntimeModelBackendBinding(params: {
  provider: string | undefined;
  runtime: string | undefined;
  config?: OpenClawConfig;
}): CliRuntimeModelBackendBinding | undefined {
  const provider = normalizeProviderId(params.provider ?? "");
  const runtime = normalizeProviderId(params.runtime ?? "");
  if (!provider || !runtime) {
    return undefined;
  }
  const runtimeBinding = listCliRuntimeModelBackendBindings().find(
    (binding) =>
      binding.runtime === runtime && (binding.provider === provider || runtime === provider),
  );
  if (runtimeBinding) {
    return runtimeBinding;
  }
  if (params.config === undefined) {
    return undefined;
  }
  const setupBackend = resolvePluginSetupCliBackend({
    backend: runtime,
    config: params.config,
  });
  if (!setupBackend) {
    return undefined;
  }
  const setupProvider = resolveCliBackendModelProvider(setupBackend.backend);
  return setupProvider && (setupProvider === provider || runtime === provider)
    ? {
        provider: setupProvider,
        runtime,
      }
    : undefined;
}

export function isCliRuntimeModelBackendForProvider(params: {
  provider: string | undefined;
  runtime: string | undefined;
  config?: OpenClawConfig;
}): boolean {
  return resolveCliRuntimeModelBackendBinding(params) !== undefined;
}

export function resolveCliBackendLiveTest(provider: string): ResolvedCliBackendLiveTest | null {
  const normalized = normalizeProviderId(provider);
  const entry =
    resolvePluginSetupCliBackend({ backend: normalized }) ??
    resolveRuntimeCliBackends().find((backend) => normalizeProviderId(backend.id) === normalized);
  if (!entry) {
    return null;
  }
  const backend = "backend" in entry ? entry.backend : entry;
  return {
    defaultModelRef: backend.liveTest?.defaultModelRef,
    defaultImageProbe: backend.liveTest?.defaultImageProbe === true,
    defaultMcpProbe: backend.liveTest?.defaultMcpProbe === true,
    dockerNpmPackage: backend.liveTest?.docker?.npmPackage,
    dockerBinaryName: backend.liveTest?.docker?.binaryName,
  };
}

/** Whether the backend can branch a native session at a recorded checkpoint. */
export function cliBackendSupportsSessionFork(provider: string, cfg?: OpenClawConfig): boolean {
  const config = resolveCliBackendConfig(provider, cfg)?.config;
  return Boolean(config?.forkArg && config.resumeAtArg);
}

export function resolveCliBackendConfig(
  provider: string,
  cfg?: OpenClawConfig,
  options: { agentId?: string } = {},
): ResolvedCliBackend | null {
  const normalized = normalizeProviderId(provider);
  const normalizeContext: CliBackendNormalizeConfigContext = {
    backendId: normalized,
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(cfg ? { config: cfg } : {}),
  };
  const runtimeTextTransforms = resolveRuntimeTextTransforms();
  const registered = resolveRuntimeCliBackends().find(
    (entry) => normalizeProviderId(entry.id) === normalized,
  );
  const backend = registered ?? resolvePluginSetupCliBackend({ backend: normalized })?.backend;
  if (!backend) {
    return null;
  }
  const baseConfig = registered ? { ...backend.config } : backend.config;
  const config = backend.normalizeConfig
    ? backend.normalizeConfig(baseConfig, normalizeContext)
    : baseConfig;
  const command = config.command?.trim();
  if (!command) {
    return null;
  }
  const modelProvider = resolveCliBackendModelProvider(backend);
  const bundleMcp = backend.bundleMcp === true;
  return {
    id: normalized,
    ...(modelProvider ? { modelProvider } : {}),
    config: { ...config, command },
    bundleMcp,
    bundleMcpMode: bundleMcp ? (backend.bundleMcpMode ?? "claude-config-file") : undefined,
    ...(registered ? { pluginId: registered.pluginId } : {}),
    transformSystemPrompt: backend.transformSystemPrompt,
    textTransforms: mergePluginTextTransforms(runtimeTextTransforms, backend.textTransforms),
    defaultAuthProfileId: backend.defaultAuthProfileId,
    authEpochMode: backend.authEpochMode,
    autoSelectAuthProfile: backend.autoSelectAuthProfile,
    contextEngineHostCapabilities: backend.contextEngineHostCapabilities,
    ownsNativeCompaction: backend.ownsNativeCompaction,
    manualCompaction: backend.manualCompaction,
    prepareExecution: backend.prepareExecution,
    resolveExecutionArgs: backend.resolveExecutionArgs,
    resolveModelId: backend.resolveModelId,
    parseJsonlEvent: backend.parseJsonlEvent,
    parseJsonlLifecycleEvent: backend.parseJsonlLifecycleEvent,
    toolAvailabilityEnforcement: backend.toolAvailabilityEnforcement,
    projectNativeToolAuthority: backend.projectNativeToolAuthority,
    nativeToolMode: backend.nativeToolMode,
    hostOwnedTools: backend.hostOwnedTools,
    sideQuestionToolMode: backend.sideQuestionToolMode,
    runtimeArtifact: backend.runtimeArtifact,
  };
}
