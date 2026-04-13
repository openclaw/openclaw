import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isRecord } from "../utils.js";
import {
  mergeProviders,
  mergeWithExistingProviderSecrets,
  type ExistingProviderConfig,
} from "./models-config.merge.js";
import {
  applyNativeStreamingUsageCompat,
  enforceSourceManagedProviderSecrets,
  normalizeProviders,
  resolveImplicitProviders,
  type ProviderConfig,
} from "./models-config.providers.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
export type ResolveImplicitProvidersForModelsJson = (params: {
  agentDir: string;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  explicitProviders: Record<string, ProviderConfig>;
}) => Promise<Record<string, ProviderConfig>>;

export type ModelsJsonPlan =
  | {
      action: "skip";
    }
  | {
      action: "noop";
    }
  | {
      action: "write";
      contents: string;
    };

export async function resolveProvidersForModelsJsonWithDeps(
  params: {
    cfg: OpenClawConfig;
    agentDir: string;
    env: NodeJS.ProcessEnv;
  },
  deps?: {
    resolveImplicitProviders?: ResolveImplicitProvidersForModelsJson;
  },
): Promise<Record<string, ProviderConfig>> {
  const { cfg, agentDir, env } = params;
  const explicitProviders = cfg.models?.providers ?? {};
  const resolveImplicitProvidersImpl = deps?.resolveImplicitProviders ?? resolveImplicitProviders;
  const implicitProviders = await resolveImplicitProvidersImpl({
    agentDir,
    config: cfg,
    env,
    explicitProviders,
  });
  return mergeProviders({
    implicit: implicitProviders,
    explicit: explicitProviders,
  });
}

function resolveExplicitBaseUrlProviders(
  providers: OpenClawConfig["models"] | undefined,
): ReadonlySet<string> {
  return new Set(
    Object.entries(providers?.providers ?? {})
      .map(([key, provider]) => [key.trim(), provider] as const)
      .filter(
        ([key, provider]) =>
          Boolean(key) && typeof provider?.baseUrl === "string" && provider.baseUrl.trim(),
      )
      .map(([key]) => key),
  );
}

function resolveProvidersForMode(params: {
  mode: NonNullable<ModelsConfig["mode"]>;
  existingParsed: unknown;
  providers: Record<string, ProviderConfig>;
  secretRefManagedProviders: ReadonlySet<string>;
  explicitBaseUrlProviders: ReadonlySet<string>;
}): Record<string, ProviderConfig> {
  if (params.mode !== "merge") {
    return params.providers;
  }
  const existing = params.existingParsed;
  if (!isRecord(existing) || !isRecord(existing.providers)) {
    return params.providers;
  }
  const existingProviders = existing.providers as Record<
    string,
    NonNullable<ModelsConfig["providers"]>[string]
  >;
  return mergeWithExistingProviderSecrets({
    nextProviders: params.providers,
    existingProviders: existingProviders as Record<string, ExistingProviderConfig>,
    secretRefManagedProviders: params.secretRefManagedProviders,
    explicitBaseUrlProviders: params.explicitBaseUrlProviders,
  });
}

export async function planOpenClawModelsJsonWithDeps(
  params: {
    cfg: OpenClawConfig;
    sourceConfigForSecrets?: OpenClawConfig;
    agentDir: string;
    env: NodeJS.ProcessEnv;
    existingRaw: string;
    existingParsed: unknown;
  },
  deps?: {
    resolveImplicitProviders?: ResolveImplicitProvidersForModelsJson;
  },
): Promise<ModelsJsonPlan> {
  const { cfg, agentDir, env } = params;
  const providers = await resolveProvidersForModelsJsonWithDeps({ cfg, agentDir, env }, deps);

  if (Object.keys(providers).length === 0) {
    return { action: "skip" };
  }

  const mode = cfg.models?.mode ?? "merge";
  const secretRefManagedProviders = new Set<string>();
  const normalizedProviders =
    normalizeProviders({
      providers,
      agentDir,
      env,
      secretDefaults: cfg.secrets?.defaults,
      sourceProviders: params.sourceConfigForSecrets?.models?.providers,
      sourceSecretDefaults: params.sourceConfigForSecrets?.secrets?.defaults,
      secretRefManagedProviders,
    }) ?? providers;
  const mergedProviders = resolveProvidersForMode({
    mode,
    existingParsed: params.existingParsed,
    providers: normalizedProviders,
    secretRefManagedProviders,
    explicitBaseUrlProviders: resolveExplicitBaseUrlProviders(cfg.models),
  });
  const secretEnforcedProviders =
    enforceSourceManagedProviderSecrets({
      providers: mergedProviders,
      sourceProviders: params.sourceConfigForSecrets?.models?.providers,
      sourceSecretDefaults: params.sourceConfigForSecrets?.secrets?.defaults,
      secretRefManagedProviders,
    }) ?? mergedProviders;
  const compatProviders = applyNativeStreamingUsageCompat(secretEnforcedProviders);

  // Strip custom models from providers that the pi SDK model registry would
  // reject.  The registry requires `apiKey` when a `models` array is present;
  // providers that authenticate differently (OAuth, aws-sdk with IAM role, etc.)
  // may legitimately lack an apiKey yet still contribute models through plugin
  // discovery.  If such an entry is written to models.json the registry rejects
  // the *entire* file, silently hiding all custom-provider models from the
  // catalog and /model picker.
  //
  // A provider is considered "auth-capable without apiKey" when it declares an
  // alternative auth mode (`auth`, `authHeader`) — those providers are kept
  // intact.  Only providers that have models, no apiKey, *and* no alternative
  // auth signal are stripped.  The provider entry itself (baseUrl, compat,
  // modelOverrides) is preserved for override-only use.
  const finalProviders: Record<string, ProviderConfig> = {};
  for (const [key, provider] of Object.entries(compatProviders)) {
    if (!provider || typeof provider !== "object") {
      continue;
    }
    const hasModels = Array.isArray(provider.models) && provider.models.length > 0;
    const hasApiKey = Boolean(provider.apiKey);
    const hasAltAuth = Boolean(provider.auth || provider.authHeader);
    if (hasModels && !hasApiKey && !hasAltAuth) {
      const { models: _stripped, ...rest } = provider;
      // Keep the provider entry only if it still has meaningful config
      if (Object.keys(rest).length > 0) {
        finalProviders[key] = rest as ProviderConfig;
      }
    } else {
      finalProviders[key] = provider;
    }
  }

  const nextContents = `${JSON.stringify({ providers: finalProviders }, null, 2)}\n`;

  if (params.existingRaw === nextContents) {
    return { action: "noop" };
  }

  return {
    action: "write",
    contents: nextContents,
  };
}

export async function planOpenClawModelsJson(
  params: Parameters<typeof planOpenClawModelsJsonWithDeps>[0],
): Promise<ModelsJsonPlan> {
  return planOpenClawModelsJsonWithDeps(params);
}
