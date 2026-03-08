import fs from "node:fs/promises";
import path from "node:path";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  type OpenClawConfig,
  loadConfig,
} from "../config/config.js";
import { applyConfigEnvVars } from "../config/env-vars.js";
import { isRecord } from "../utils.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import {
  mergeProviders,
  mergeProviderModels,
  mergeWithExistingProviderSecrets,
  type ExistingProviderConfig,
} from "./models-config.merge.js";
import {
  normalizeProviders,
  type ProviderConfig,
  resolveImplicitBedrockProvider,
  resolveImplicitCopilotProvider,
  resolveImplicitProviders,
} from "./models-config.providers.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;

const DEFAULT_MODE: NonNullable<ModelsConfig["mode"]> = "merge";
const MODELS_JSON_WRITE_LOCKS = new Map<string, Promise<void>>();

async function readJson(pathname: string): Promise<unknown> {
  try {
    const raw = await fs.readFile(pathname, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

async function resolveProvidersForModelsJson(params: {
  cfg: OpenClawConfig;
  agentDir: string;
}): Promise<Record<string, ProviderConfig>> {
  const { cfg, agentDir } = params;
  const explicitProviders = cfg.models?.providers ?? {};
  const implicitProviders = await resolveImplicitProviders({ agentDir, explicitProviders });
  const providers: Record<string, ProviderConfig> = mergeProviders({
    implicit: implicitProviders,
    explicit: explicitProviders,
  });

  const implicitBedrock = await resolveImplicitBedrockProvider({ agentDir, config: cfg });
  if (implicitBedrock) {
    const existing = providers["amazon-bedrock"];
    providers["amazon-bedrock"] = existing
      ? mergeProviderModels(implicitBedrock, existing)
      : implicitBedrock;
  }

  const implicitCopilot = await resolveImplicitCopilotProvider({ agentDir });
  if (implicitCopilot && !providers["github-copilot"]) {
    providers["github-copilot"] = implicitCopilot;
  }
  return providers;
}

async function resolveProvidersForMode(params: {
  mode: NonNullable<ModelsConfig["mode"]>;
  targetPath: string;
  providers: Record<string, ProviderConfig>;
  secretRefManagedProviders: ReadonlySet<string>;
  explicitBaseUrlProviders: ReadonlySet<string>;
}): Promise<Record<string, ProviderConfig>> {
  if (params.mode !== "merge") {
    return params.providers;
  }
  const existing = await readJson(params.targetPath);
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

async function readRawFile(pathname: string): Promise<string> {
  try {
    return await fs.readFile(pathname, "utf8");
  } catch {
    return "";
  }
}

async function ensureModelsFileMode(pathname: string): Promise<void> {
  await fs.chmod(pathname, 0o600).catch(() => {
    // best-effort
  });
}

function resolveModelsConfigInput(config?: OpenClawConfig): OpenClawConfig {
  const runtimeSource = getRuntimeConfigSourceSnapshot();
  if (!runtimeSource) {
    return config ?? loadConfig();
  }
  if (!config) {
    return runtimeSource;
  }
  const runtimeResolved = getRuntimeConfigSnapshot();
  if (runtimeResolved && config === runtimeResolved) {
    return runtimeSource;
  }
  return config;
}

async function withModelsJsonWriteLock<T>(targetPath: string, run: () => Promise<T>): Promise<T> {
  const prior = MODELS_JSON_WRITE_LOCKS.get(targetPath) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = prior.then(() => gate);
  MODELS_JSON_WRITE_LOCKS.set(targetPath, pending);
  try {
    await prior;
    return await run();
  } finally {
    release();
    if (MODELS_JSON_WRITE_LOCKS.get(targetPath) === pending) {
      MODELS_JSON_WRITE_LOCKS.delete(targetPath);
    }
  }
}

export async function ensureOpenClawModelsJson(
  config?: OpenClawConfig,
  agentDirOverride?: string,
): Promise<{ agentDir: string; wrote: boolean }> {
  const cfg = resolveModelsConfigInput(config);
  const agentDir = agentDirOverride?.trim() ? agentDirOverride.trim() : resolveOpenClawAgentDir();
  const targetPath = path.join(agentDir, "models.json");

  return await withModelsJsonWriteLock(targetPath, async () => {
    // Ensure config env vars (e.g. AWS_PROFILE, AWS_ACCESS_KEY_ID) are
    // available in process.env before implicit provider discovery. Some
    // callers (agent runner, tools) pass config objects that haven't gone
    // through the full loadConfig() pipeline which applies these.
    applyConfigEnvVars(cfg);

    const providers = await resolveProvidersForModelsJson({ cfg, agentDir });

    if (Object.keys(providers).length === 0) {
      return { agentDir, wrote: false };
    }

    const mode = cfg.models?.mode ?? DEFAULT_MODE;
    const secretRefManagedProviders = new Set<string>();
    const explicitBaseUrlProviders = new Set(
      Object.entries(cfg.models?.providers ?? {})
        .map(([key, provider]) => [key.trim(), provider] as const)
        .filter(
          ([key, provider]) =>
            Boolean(key) && typeof provider?.baseUrl === "string" && provider.baseUrl.trim(),
        )
        .map(([key]) => key),
    );

    const normalizedProviders =
      normalizeProviders({
        providers,
        agentDir,
        secretDefaults: cfg.secrets?.defaults,
        secretRefManagedProviders,
      }) ?? providers;
    const mergedProviders = await resolveProvidersForMode({
      mode,
      targetPath,
      providers: normalizedProviders,
      secretRefManagedProviders,
      explicitBaseUrlProviders,
    });
    const next = `${JSON.stringify({ providers: mergedProviders }, null, 2)}\n`;
    const existingRaw = await readRawFile(targetPath);

    if (existingRaw === next) {
      await ensureModelsFileMode(targetPath);
      return { agentDir, wrote: false };
    }

    await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(targetPath, next, { mode: 0o600 });
    await ensureModelsFileMode(targetPath);
    return { agentDir, wrote: true };
  });
}
