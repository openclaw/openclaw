/**
 * Resolves CLI runtime backends registered by plugins or setup metadata.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimeCliBackends } from "../plugins/cli-backends.runtime.js";
import {
  resolvePluginSetupCliBackend,
  resolvePluginSetupRegistry,
} from "../plugins/setup-registry.js";
import { resolveRuntimeTextTransforms } from "../plugins/text-transforms.runtime.js";
import type { CliBackendNormalizeConfigContext, CliBackendPlugin } from "../plugins/types.js";
import { mergePluginTextTransforms } from "./plugin-text-transforms.js";

/** Fully merged CLI backend definition used by agent runner execution. */
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
  | "isolatesInstructionsWithExactTools"
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

/** Binding between a model provider and the CLI runtime that serves it. */
type CliRuntimeModelBackendBinding = {
  provider: string;
  runtime: string;
  pluginId?: string;
};

function resolveCliBackendModelProvider(
  backend: Pick<CliBackendPlugin, "modelProvider">,
): string | undefined {
  const provider = backend.modelProvider?.trim();
  return provider ? normalizeProviderId(provider) : undefined;
}

function addCliRuntimeModelBinding(
  bindings: Map<string, CliRuntimeModelBackendBinding>,
  params: { backend: Pick<CliBackendPlugin, "id" | "modelProvider">; pluginId?: string },
): void {
  const provider = resolveCliBackendModelProvider(params.backend);
  const runtime = normalizeProviderId(params.backend.id);
  if (!provider || !runtime) {
    return;
  }
  bindings.set(`${provider}:${runtime}`, {
    provider,
    runtime,
    ...(params.pluginId ? { pluginId: params.pluginId } : {}),
  });
}

/** Lists model-provider to CLI-runtime bindings from runtime and optional setup registries. */
export function listCliRuntimeModelBackendBindings(
  params: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    includeSetupRegistry?: boolean;
  } = {},
): CliRuntimeModelBackendBinding[] {
  const bindings = new Map<string, CliRuntimeModelBackendBinding>();
  for (const backend of resolveRuntimeCliBackends("metadata")) {
    addCliRuntimeModelBinding(bindings, {
      backend,
      ...(backend.pluginId ? { pluginId: backend.pluginId } : {}),
    });
  }
  if (params.includeSetupRegistry === true) {
    for (const entry of resolvePluginSetupRegistry({
      config: params.config,
      env: params.env,
    }).cliBackends) {
      addCliRuntimeModelBinding(bindings, {
        backend: entry.backend,
        pluginId: entry.pluginId,
      });
    }
  }
  return [...bindings.values()].toSorted((left, right) =>
    left.provider === right.provider
      ? left.runtime.localeCompare(right.runtime)
      : left.provider.localeCompare(right.provider),
  );
}

/** Lists CLI runtime ids that alias canonical model providers. */
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

/** Resolves the canonical model provider served by a CLI runtime id. */
export function resolveCliRuntimeCanonicalProvider(params: {
  runtime: string | undefined;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  includeSetupRegistry?: boolean;
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
  if (params.includeSetupRegistry !== true) {
    return undefined;
  }
  const setupBackend = resolvePluginSetupCliBackend({
    backend: runtime,
    config: params.config,
    env: params.env,
  });
  return setupBackend ? resolveCliBackendModelProvider(setupBackend.backend) : undefined;
}

/** Resolves the binding for one provider/runtime pair when registered. */
export function resolveCliRuntimeModelBackendBinding(params: {
  provider: string | undefined;
  runtime: string | undefined;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
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
  const includeSetupRegistry = params.config !== undefined || params.env !== undefined;
  if (!includeSetupRegistry) {
    return undefined;
  }
  const setupBackend = resolvePluginSetupCliBackend({
    backend: runtime,
    config: params.config,
    env: params.env,
  });
  if (!setupBackend) {
    return undefined;
  }
  const setupProvider = resolveCliBackendModelProvider(setupBackend.backend);
  return setupProvider && (setupProvider === provider || runtime === provider)
    ? {
        provider: setupProvider,
        runtime,
        ...(setupBackend.pluginId ? { pluginId: setupBackend.pluginId } : {}),
      }
    : undefined;
}

/** Checks whether a runtime is registered to serve a model provider. */
export function isCliRuntimeModelBackendForProvider(params: {
  provider: string | undefined;
  runtime: string | undefined;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return resolveCliRuntimeModelBackendBinding(params) !== undefined;
}

/** Resolves live-test defaults advertised by a CLI backend plugin. */
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

/** Resolves the executable CLI backend registered by its owning plugin. */
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
    isolatesInstructionsWithExactTools: backend.isolatesInstructionsWithExactTools,
    projectNativeToolAuthority: backend.projectNativeToolAuthority,
    nativeToolMode: backend.nativeToolMode,
    hostOwnedTools: backend.hostOwnedTools,
    sideQuestionToolMode: backend.sideQuestionToolMode,
    runtimeArtifact: backend.runtimeArtifact,
  };
}
