import type { OpenClawConfig } from "../config/config.js";
import { isRecord } from "../utils.js";
import {
  mergeProviders,
  mergeWithExistingProviderSecrets,
  type ExistingProviderConfig,
} from "./models-config.merge.js";
import {
  enforceSourceManagedProviderSecrets,
  normalizeProviders,
  resolveImplicitProviders,
  type ProviderConfig,
} from "./models-config.providers.js";

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
  const hasExplicitProviders = Object.keys(explicitProviders).length > 0;

  // When explicit providers are configured, skip implicit discovery entirely
  // to avoid unrelated outbound API calls / latency (#33327).
  if (hasExplicitProviders) {
    return mergeProviders({
      implicit: undefined,
      explicit: explicitProviders,
    });
  }

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

async function resolveProvidersForMode(params: {
  mode: NonNullable<ModelsConfig["mode"]>;
  existingParsed: unknown;
  providers: Record<string, ProviderConfig>;
  secretRefManagedProviders: ReadonlySet<string>;
  explicitBaseUrlProviders: ReadonlySet<string>;
  hasExplicitProviders?: boolean;
}): Promise<Record<string, ProviderConfig>> {
  if (params.mode !== "merge") {
    return params.providers;
  }
  const existing = params.existingParsed;
  if (!isRecord(existing) || !isRecord(existing.providers)) {
    return params.providers;
  }
  let existingProviders = existing.providers as Record<
    string,
    NonNullable<ModelsConfig["providers"]>[string]
  >;

  // When explicit providers are configured, prune previously-written implicit
  // providers from the existing models.json that are no longer in the resolved
  // set, so stale auto-detected entries do not remain routable (#33327).
  if (params.hasExplicitProviders) {
    const nextKeys = new Set(Object.keys(params.providers));
    existingProviders = Object.fromEntries(
      Object.entries(existingProviders).filter(([key]) => nextKeys.has(key)),
    );
  }

  return mergeWithExistingProviderSecrets({
    nextProviders: params.providers,
    existingProviders: existingProviders as Record<string, ExistingProviderConfig>,
    secretRefManagedProviders: params.secretRefManagedProviders,
    explicitBaseUrlProviders: params.explicitBaseUrlProviders,
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
  const hasExplicitProviders = Object.keys(cfg.models?.providers ?? {}).length > 0;
  const mergedProviders = await resolveProvidersForMode({
    mode,
    existingParsed: params.existingParsed,
    providers: normalizedProviders,
    secretRefManagedProviders,
    explicitBaseUrlProviders: resolveExplicitBaseUrlProviders(cfg.models),
    hasExplicitProviders,
  });
  const secretEnforcedProviders =
    enforceSourceManagedProviderSecrets({
      providers: mergedProviders,
      sourceProviders: params.sourceConfigForSecrets?.models?.providers,
      sourceSecretDefaults: params.sourceConfigForSecrets?.secrets?.defaults,
      secretRefManagedProviders,
    }) ?? mergedProviders;
  const nextContents = `${JSON.stringify({ providers: secretEnforcedProviders }, null, 2)}\n`;

  if (params.existingRaw === nextContents) {
    return { action: "noop" };
  }

  return {
    action: "write",
    contents: nextContents,
  };
}
