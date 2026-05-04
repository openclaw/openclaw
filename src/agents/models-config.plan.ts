import { appendAgentExecDebug } from "../cli/agent-exec-debug.js";
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
  commandName?: string;
  effectiveToolPolicy?: string;
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
    commandName?: string;
    effectiveToolPolicy?: string;
  },
  deps?: {
    resolveImplicitProviders?: ResolveImplicitProvidersForModelsJson;
  },
): Promise<Record<string, ProviderConfig>> {
  if (process.env.OPENCLAW_AGENT_EXEC_DEBUG === "1") {
    appendAgentExecDebug(
      "models-config",
      "modelsConfig_resolveProvidersForModelsJsonWithDeps_enter",
      {
        raw_commandName: params.commandName ?? null,
        raw_effectiveToolPolicy: params.effectiveToolPolicy ?? null,
        has_commandName: typeof params.commandName === "string" && params.commandName.length > 0,
        has_effectiveToolPolicy:
          typeof params.effectiveToolPolicy === "string" && params.effectiveToolPolicy.length > 0,
        calls_resolveImplicitProviders: true,
      },
    );
    appendAgentExecDebug("models-config", "modelsConfig_before_resolveImplicitProviders", {
      raw_commandName: params.commandName ?? null,
      raw_effectiveToolPolicy: params.effectiveToolPolicy ?? null,
      has_commandName: typeof params.commandName === "string" && params.commandName.length > 0,
      has_effectiveToolPolicy:
        typeof params.effectiveToolPolicy === "string" && params.effectiveToolPolicy.length > 0,
      calls_resolveImplicitProviders: true,
    });
  }
  const { cfg, agentDir, env } = params;
  const explicitProviders = cfg.models?.providers ?? {};
  const resolveImplicitProvidersImpl = deps?.resolveImplicitProviders ?? resolveImplicitProviders;
  const implicitProviders = await resolveImplicitProvidersImpl({
    agentDir,
    config: cfg,
    env,
    explicitProviders,
    commandName: params.commandName,
    effectiveToolPolicy: params.effectiveToolPolicy,
  });
  return mergeProviders({
    implicit: implicitProviders,
    explicit: explicitProviders,
  });
}

function resolveProvidersForMode(params: {
  mode: NonNullable<ModelsConfig["mode"]>;
  existingParsed: unknown;
  providers: Record<string, ProviderConfig>;
  secretRefManagedProviders: ReadonlySet<string>;
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
    commandName?: string;
    effectiveToolPolicy?: string;
  },
  deps?: {
    resolveImplicitProviders?: ResolveImplicitProvidersForModelsJson;
  },
): Promise<ModelsJsonPlan> {
  if (process.env.OPENCLAW_AGENT_EXEC_DEBUG === "1") {
    appendAgentExecDebug("models-config", "modelsConfig_planOpenClawModelsJsonWithDeps_enter", {
      raw_commandName: params.commandName ?? null,
      raw_effectiveToolPolicy: params.effectiveToolPolicy ?? null,
      has_commandName: typeof params.commandName === "string" && params.commandName.length > 0,
      has_effectiveToolPolicy:
        typeof params.effectiveToolPolicy === "string" && params.effectiveToolPolicy.length > 0,
    });
  }
  const { cfg, agentDir, env } = params;
  const providers = await resolveProvidersForModelsJsonWithDeps(
    {
      cfg,
      agentDir,
      env,
      commandName: params.commandName,
      effectiveToolPolicy: params.effectiveToolPolicy,
    },
    deps,
  );

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

export async function planOpenClawModelsJson(
  params: Parameters<typeof planOpenClawModelsJsonWithDeps>[0],
): Promise<ModelsJsonPlan> {
  if (process.env.OPENCLAW_AGENT_EXEC_DEBUG === "1") {
    appendAgentExecDebug("models-config", "modelsConfig_planOpenClawModelsJson_enter", {
      raw_commandName: params.commandName ?? null,
      raw_effectiveToolPolicy: params.effectiveToolPolicy ?? null,
      has_commandName: typeof params.commandName === "string" && params.commandName.length > 0,
      has_effectiveToolPolicy:
        typeof params.effectiveToolPolicy === "string" && params.effectiveToolPolicy.length > 0,
    });
  }
  return planOpenClawModelsJsonWithDeps(params);
}
