import type { OpenClawConfig } from "../config/config.js";
import { isRecord } from "../utils.js";
import {
  mergeProviders,
  mergeWithExistingProviderSecrets,
  type ExistingProviderConfig,
} from "./models-config.merge.js";
import { resolveImplicitProviders } from "./models-config.providers.implicit.js";
import { normalizeProviders } from "./models-config.providers.normalize.js";
import { applyNativeStreamingUsageCompat } from "./models-config.providers.policy.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";
import { enforceSourceManagedProviderSecrets } from "./models-config.providers.source-managed.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;

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

async function resolveProvidersForModelsJson(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<Record<string, ProviderConfig>> {
  const { cfg, agentDir, env } = params;
  const explicitProviders = cfg.models?.providers ?? {};
  const implicitProviders = await resolveImplicitProviders({
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

function resolveExplicitProviders(
  providers: OpenClawConfig["models"] | undefined,
): ReadonlySet<string> {
  return new Set(
    Object.keys(providers?.providers ?? {})
      .map((key) => key.trim())
      .filter(Boolean),
  );
}

async function resolveProvidersForMode(params: {
  mode: NonNullable<ModelsConfig["mode"]>;
  existingParsed: unknown;
  providers: Record<string, ProviderConfig>;
  secretRefManagedProviders: ReadonlySet<string>;
  explicitBaseUrlProviders: ReadonlySet<string>;
  explicitProviders: ReadonlySet<string>;
}): Promise<Record<string, ProviderConfig>> {
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
    explicitProviders: params.explicitProviders,
  });
}

export async function planOpenClawModelsJson(params: {
  cfg: OpenClawConfig;
  sourceConfigForSecrets?: OpenClawConfig;
  agentDir: string;
  env: NodeJS.ProcessEnv;
  existingRaw: string;
  existingParsed: unknown;
}): Promise<ModelsJsonPlan> {
  const { cfg, agentDir, env } = params;
  const providers = await resolveProvidersForModelsJson({ cfg, agentDir, env });

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
    explicitProviders: resolveExplicitProviders(cfg.models),
  });
  const secretEnforcedProviders =
    enforceSourceManagedProviderSecrets({
      providers: mergedProviders,
      sourceProviders: params.sourceConfigForSecrets?.models?.providers,
      sourceSecretDefaults: params.sourceConfigForSecrets?.secrets?.defaults,
      secretRefManagedProviders,
    }) ?? mergedProviders;
  const finalProviders = applyNativeStreamingUsageCompat(secretEnforcedProviders);
  const nextContents = `${JSON.stringify({ providers: finalProviders }, null, 2)}\n`;

  if (params.existingRaw === nextContents) {
    return { action: "noop" };
  }

  return {
    action: "write",
    contents: nextContents,
  };
}
