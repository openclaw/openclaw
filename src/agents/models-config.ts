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
import { isNonSecretApiKeyMarker } from "./model-auth-markers.js";
import {
  normalizeProviders,
  type ProviderConfig,
  resolveImplicitBedrockProvider,
  resolveImplicitCopilotProvider,
  resolveImplicitProviders,
} from "./models-config.providers.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
type ExistingProviderConfig = NonNullable<ModelsConfig["providers"]>[string] & {
  apiKey?: string;
  baseUrl?: string;
  api?: string;
};

const DEFAULT_MODE: NonNullable<ModelsConfig["mode"]> = "merge";
const MODELS_JSON_WRITE_LOCKS = new Map<string, Promise<void>>();

function isPositiveFiniteTokenLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function resolvePreferredTokenLimit(params: {
  explicitPresent: boolean;
  explicitValue: unknown;
  implicitValue: unknown;
}): number | undefined {
  if (params.explicitPresent && isPositiveFiniteTokenLimit(params.explicitValue)) {
    return params.explicitValue;
  }
  if (isPositiveFiniteTokenLimit(params.implicitValue)) {
    return params.implicitValue;
  }
  return isPositiveFiniteTokenLimit(params.explicitValue) ? params.explicitValue : undefined;
}

function mergeProviderModels(implicit: ProviderConfig, explicit: ProviderConfig): ProviderConfig {
  const implicitModels = Array.isArray(implicit.models) ? implicit.models : [];
  const explicitModels = Array.isArray(explicit.models) ? explicit.models : [];
  if (implicitModels.length === 0) {
    return { ...implicit, ...explicit };
  }

  const getId = (model: unknown): string => {
    if (!model || typeof model !== "object") {
      return "";
    }
    const id = (model as { id?: unknown }).id;
    return typeof id === "string" ? id.trim() : "";
  };
  const implicitById = new Map(
    implicitModels.map((model) => [getId(model), model] as const).filter(([id]) => Boolean(id)),
  );
  const seen = new Set<string>();

  const mergedModels = explicitModels.map((explicitModel) => {
    const id = getId(explicitModel);
    if (!id) {
      return explicitModel;
    }
    seen.add(id);
    const implicitModel = implicitById.get(id);
    if (!implicitModel) {
      return explicitModel;
    }

    // Refresh capability metadata from the implicit catalog while preserving
    // user-specific fields (cost, headers, compat, etc.) on explicit entries.
    // reasoning is treated as user-overridable: if the user has explicitly set
    // it in their config (key present), honour that value; otherwise fall back
    // to the built-in catalog default so new reasoning models work out of the
    // box without requiring every user to configure it.
    const contextWindow = resolvePreferredTokenLimit({
      explicitPresent: "contextWindow" in explicitModel,
      explicitValue: explicitModel.contextWindow,
      implicitValue: implicitModel.contextWindow,
    });
    const maxTokens = resolvePreferredTokenLimit({
      explicitPresent: "maxTokens" in explicitModel,
      explicitValue: explicitModel.maxTokens,
      implicitValue: implicitModel.maxTokens,
    });

    return {
      ...explicitModel,
      input: implicitModel.input,
      reasoning: "reasoning" in explicitModel ? explicitModel.reasoning : implicitModel.reasoning,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    };
  });

  for (const implicitModel of implicitModels) {
    const id = getId(implicitModel);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    mergedModels.push(implicitModel);
  }

  return {
    ...implicit,
    ...explicit,
    models: mergedModels,
  };
}

function mergeProviders(params: {
  implicit?: Record<string, ProviderConfig> | null;
  explicit?: Record<string, ProviderConfig> | null;
}): Record<string, ProviderConfig> {
  const out: Record<string, ProviderConfig> = params.implicit ? { ...params.implicit } : {};
  for (const [key, explicit] of Object.entries(params.explicit ?? {})) {
    const providerKey = key.trim();
    if (!providerKey) {
      continue;
    }
    const implicit = out[providerKey];
    out[providerKey] = implicit ? mergeProviderModels(implicit, explicit) : explicit;
  }
  return out;
}

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

function resolveProviderApi(entry: { api?: unknown } | undefined): string | undefined {
  if (typeof entry?.api !== "string") {
    return undefined;
  }
  const api = entry.api.trim();
  return api || undefined;
}

function shouldPreserveExistingApiKey(params: {
  providerKey: string;
  existing: ExistingProviderConfig;
  secretRefManagedProviders: ReadonlySet<string>;
}): boolean {
  const { providerKey, existing, secretRefManagedProviders } = params;
  return (
    !secretRefManagedProviders.has(providerKey) &&
    typeof existing.apiKey === "string" &&
    existing.apiKey.length > 0 &&
    !isNonSecretApiKeyMarker(existing.apiKey, { includeEnvVarName: false })
  );
}

function shouldPreserveExistingBaseUrl(params: {
  providerKey: string;
  existing: ExistingProviderConfig;
  nextEntry: ProviderConfig;
  explicitBaseUrlProviders: ReadonlySet<string>;
}): boolean {
  const { providerKey, existing, nextEntry, explicitBaseUrlProviders } = params;
  if (
    explicitBaseUrlProviders.has(providerKey) ||
    typeof existing.baseUrl !== "string" ||
    existing.baseUrl.length === 0
  ) {
    return false;
  }

  const existingApi = resolveProviderApi(existing);
  const nextApi = resolveProviderApi(nextEntry);
  return !existingApi || !nextApi || existingApi === nextApi;
}

function mergeWithExistingProviderSecrets(params: {
  nextProviders: Record<string, ProviderConfig>;
  existingProviders: Record<string, ExistingProviderConfig>;
  secretRefManagedProviders: ReadonlySet<string>;
  explicitBaseUrlProviders: ReadonlySet<string>;
}): Record<string, ProviderConfig> {
  const { nextProviders, existingProviders, secretRefManagedProviders, explicitBaseUrlProviders } =
    params;
  const mergedProviders: Record<string, ProviderConfig> = {};
  for (const [key, entry] of Object.entries(existingProviders)) {
    mergedProviders[key] = entry;
  }
  for (const [key, newEntry] of Object.entries(nextProviders)) {
    const existing = existingProviders[key];
    if (!existing) {
      mergedProviders[key] = newEntry;
      continue;
    }
    const preserved: Record<string, unknown> = {};
    if (shouldPreserveExistingApiKey({ providerKey: key, existing, secretRefManagedProviders })) {
      preserved.apiKey = existing.apiKey;
    }
    if (
      shouldPreserveExistingBaseUrl({
        providerKey: key,
        existing,
        nextEntry: newEntry,
        explicitBaseUrlProviders,
      })
    ) {
      preserved.baseUrl = existing.baseUrl;
    }
    mergedProviders[key] = { ...newEntry, ...preserved };
  }
  return mergedProviders;
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
