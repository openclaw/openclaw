import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  mergeImplicitAnthropicVertexProvider,
  resolveImplicitAnthropicVertexProvider,
} from "../plugin-sdk/anthropic-vertex.js";
import {
  groupPluginDiscoveryProvidersByOrder,
  normalizePluginDiscoveryResult,
  resolvePluginDiscoveryProviders,
  runProviderCatalog,
} from "../plugins/provider-discovery.js";
import { ensureAuthProfileStore } from "./auth-profiles/store.js";
import type {
  ProviderApiKeyResolver,
  ProviderAuthResolver,
  ProviderConfig,
} from "./models-config.providers.secrets.js";
import {
  createProviderApiKeyResolver,
  createProviderAuthResolver,
} from "./models-config.providers.secrets.js";

const log = createSubsystemLogger("agents/model-providers");

const PROVIDER_IMPLICIT_MERGERS: Partial<
  Record<
    string,
    (params: { existing: ProviderConfig | undefined; implicit: ProviderConfig }) => ProviderConfig
  >
> = {
  "anthropic-vertex": mergeImplicitAnthropicVertexProvider,
};

const CORE_IMPLICIT_PROVIDER_RESOLVERS = [
  {
    id: "anthropic-vertex",
    resolve: async (params: { config?: OpenClawConfig; env: NodeJS.ProcessEnv }) =>
      resolveImplicitAnthropicVertexProvider({
        env: params.env,
      }),
  },
] as const;

const PLUGIN_DISCOVERY_ORDERS = ["simple", "profile", "paired", "late"] as const;

type ImplicitProviderParams = {
  agentDir: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  explicitProviders?: Record<string, ProviderConfig> | null;
};

type ImplicitProviderContext = ImplicitProviderParams & {
  authStore: ReturnType<typeof ensureAuthProfileStore>;
  env: NodeJS.ProcessEnv;
  resolveProviderApiKey: ProviderApiKeyResolver;
  resolveProviderAuth: ProviderAuthResolver;
};

function resolveLiveProviderCatalogTimeoutMs(env: NodeJS.ProcessEnv): number | null {
  const live =
    env.OPENCLAW_LIVE_TEST === "1" || env.OPENCLAW_LIVE_GATEWAY === "1" || env.LIVE === "1";
  if (!live) {
    return null;
  }
  const raw = env.OPENCLAW_LIVE_PROVIDER_DISCOVERY_TIMEOUT_MS?.trim();
  if (!raw) {
    return 15_000;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15_000;
}

function resolveLiveProviderDiscoveryFilter(env: NodeJS.ProcessEnv): string[] | undefined {
  const live =
    env.OPENCLAW_LIVE_TEST === "1" || env.OPENCLAW_LIVE_GATEWAY === "1" || env.LIVE === "1";
  if (!live) {
    return undefined;
  }
  const raw = env.OPENCLAW_LIVE_PROVIDERS?.trim();
  if (!raw || raw === "all") {
    return undefined;
  }
  const ids = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return ids.length > 0 ? [...new Set(ids)] : undefined;
}

function mergeImplicitProviderSet(
  target: Record<string, ProviderConfig>,
  additions: Record<string, ProviderConfig> | undefined,
): void {
  if (!additions) {
    return;
  }
  for (const [key, value] of Object.entries(additions)) {
    target[key] = value;
  }
}

async function resolvePluginImplicitProviders(
  ctx: ImplicitProviderContext,
  order: import("../plugins/types.js").ProviderDiscoveryOrder,
): Promise<Record<string, ProviderConfig> | undefined> {
  const onlyPluginIds = resolveLiveProviderDiscoveryFilter(ctx.env);
  const providers = await resolvePluginDiscoveryProviders({
    config: ctx.config,
    workspaceDir: ctx.workspaceDir,
    env: ctx.env,
    onlyPluginIds,
  });
  const byOrder = groupPluginDiscoveryProvidersByOrder(providers);
  const discovered: Record<string, ProviderConfig> = {};
  const catalogConfig = buildPluginCatalogConfig(ctx);
  for (const provider of byOrder[order]) {
    const result = await runProviderCatalogWithTimeout({
      provider,
      config: catalogConfig,
      agentDir: ctx.agentDir,
      workspaceDir: ctx.workspaceDir,
      env: ctx.env,
      resolveProviderApiKey: (providerId) =>
        ctx.resolveProviderApiKey(providerId?.trim() || provider.id),
      resolveProviderAuth: (providerId, options) =>
        ctx.resolveProviderAuth(providerId?.trim() || provider.id, options),
      timeoutMs: resolveLiveProviderCatalogTimeoutMs(ctx.env),
    });
    if (!result) {
      continue;
    }
    mergeImplicitProviderSet(
      discovered,
      normalizePluginDiscoveryResult({
        provider,
        result,
      }),
    );
  }
  return Object.keys(discovered).length > 0 ? discovered : undefined;
}

function buildPluginCatalogConfig(ctx: ImplicitProviderContext): OpenClawConfig {
  if (!ctx.explicitProviders || Object.keys(ctx.explicitProviders).length === 0) {
    return ctx.config ?? {};
  }
  return {
    ...ctx.config,
    models: {
      ...ctx.config?.models,
      providers: {
        ...ctx.config?.models?.providers,
        ...ctx.explicitProviders,
      },
    },
  };
}

async function runProviderCatalogWithTimeout(
  params: Parameters<typeof runProviderCatalog>[0] & {
    timeoutMs: number | null;
  },
): Promise<Awaited<ReturnType<typeof runProviderCatalog>> | undefined> {
  const catalogRun = runProviderCatalog(params);
  const timeoutMs = params.timeoutMs ?? undefined;
  if (!timeoutMs) {
    return await catalogRun;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      catalogRun,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(`provider catalog timed out after ${timeoutMs}ms: ${params.provider.id}`),
          );
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("provider catalog timed out after")) {
      log.warn(`${message}; skipping provider discovery`);
      return undefined;
    }
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function mergeCoreImplicitProviders(params: {
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  providers: Record<string, ProviderConfig>;
}): Promise<void> {
  for (const provider of CORE_IMPLICIT_PROVIDER_RESOLVERS) {
    const implicit = await provider.resolve({ config: params.config, env: params.env });
    if (!implicit) {
      continue;
    }
    const merge = PROVIDER_IMPLICIT_MERGERS[provider.id];
    if (!merge) {
      params.providers[provider.id] = implicit;
      continue;
    }
    params.providers[provider.id] = merge({
      existing: params.providers[provider.id],
      implicit,
    });
  }
}

export async function resolveImplicitProviders(
  params: ImplicitProviderParams,
): Promise<NonNullable<OpenClawConfig["models"]>["providers"]> {
  const providers: Record<string, ProviderConfig> = {};
  const env = params.env ?? process.env;
  const authStore = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const context: ImplicitProviderContext = {
    ...params,
    authStore,
    env,
    resolveProviderApiKey: createProviderApiKeyResolver(env, authStore),
    resolveProviderAuth: createProviderAuthResolver(env, authStore),
  };

  for (const order of PLUGIN_DISCOVERY_ORDERS) {
    mergeImplicitProviderSet(providers, await resolvePluginImplicitProviders(context, order));
  }

  await mergeCoreImplicitProviders({
    config: params.config,
    env,
    providers,
  });

  return providers;
}
