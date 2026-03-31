import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveOpenClawStateDir } from "@/lib/workspace";
import {
  type DenchCloudCatalogModel,
  DEFAULT_DENCH_CLOUD_GATEWAY_URL,
  normalizeDenchGatewayUrl,
  buildDenchGatewayApiBaseUrl,
  fetchDenchCloudCatalog,
  validateDenchCloudApiKey,
  buildDenchCloudConfigPatch,
  readConfiguredDenchCloudSettings,
  RECOMMENDED_DENCH_CLOUD_MODEL_ID,
} from "../../../src/cli/dench-cloud.js";
import { refreshIntegrationsRuntime, type IntegrationRuntimeRefresh } from "./integrations";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function openClawConfigPath(): string {
  return join(resolveOpenClawStateDir(), "openclaw.json");
}

function readConfig(): UnknownRecord {
  const configPath = openClawConfigPath();
  if (!existsSync(configPath)) return {};
  try {
    return (JSON.parse(readFileSync(configPath, "utf-8")) as UnknownRecord) ?? {};
  } catch {
    return {};
  }
}

function writeConfig(config: UnknownRecord): void {
  const configPath = openClawConfigPath();
  const dirPath = resolveOpenClawStateDir();
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function resolveDenchApiKey(config: UnknownRecord): string | null {
  const models = asRecord(config.models);
  const provider = asRecord(asRecord(models?.providers)?.["dench-cloud"]);
  const configKey = typeof provider?.apiKey === "string" && provider.apiKey.trim()
    ? provider.apiKey.trim()
    : null;
  if (configKey) return configKey;
  if (process.env.DENCH_CLOUD_API_KEY?.trim()) return process.env.DENCH_CLOUD_API_KEY.trim();
  if (process.env.DENCH_API_KEY?.trim()) return process.env.DENCH_API_KEY.trim();
  return null;
}

function resolveGatewayUrl(config: UnknownRecord): string {
  const settings = readConfiguredDenchCloudSettings(config);
  return settings.gatewayUrl ?? normalizeDenchGatewayUrl(
    process.env.DENCH_GATEWAY_URL?.trim() ?? DEFAULT_DENCH_CLOUD_GATEWAY_URL,
  );
}

function resolvePrimaryModel(config: UnknownRecord): string | null {
  const agents = asRecord(config.agents);
  const defaults = asRecord(agents?.defaults);
  const model = defaults?.model;
  if (typeof model === "string") return model.trim() || null;
  const modelRecord = asRecord(model);
  const primary = modelRecord?.primary;
  return typeof primary === "string" && primary.trim() ? primary.trim() : null;
}

function ensureRecord(parent: UnknownRecord, key: string): UnknownRecord {
  const existing = asRecord(parent[key]);
  if (existing) return existing;
  const fresh: UnknownRecord = {};
  parent[key] = fresh;
  return fresh;
}

export type CloudSettingsStatus = "no_key" | "invalid_key" | "valid";

export type CloudSettingsState = {
  status: CloudSettingsStatus;
  apiKeySource: "config" | "env" | "missing";
  gatewayUrl: string;
  primaryModel: string | null;
  isDenchPrimary: boolean;
  selectedDenchModel: string | null;
  models: DenchCloudCatalogModel[];
  recommendedModelId: string;
  validationError?: string;
};

export type CloudSettingsUpdateResult = {
  state: CloudSettingsState;
  changed: boolean;
  refresh: IntegrationRuntimeRefresh;
  error?: string;
};

export async function getCloudSettingsState(): Promise<CloudSettingsState> {
  const config = readConfig();
  const apiKey = resolveDenchApiKey(config);
  const gatewayUrl = resolveGatewayUrl(config);
  const primaryModel = resolvePrimaryModel(config);
  const isDenchPrimary = Boolean(primaryModel?.startsWith("dench-cloud/"));
  const settings = readConfiguredDenchCloudSettings(config);

  const apiKeySource: "config" | "env" | "missing" = (() => {
    const models = asRecord(config.models);
    const provider = asRecord(asRecord(models?.providers)?.["dench-cloud"]);
    if (typeof provider?.apiKey === "string" && provider.apiKey.trim()) return "config";
    if (process.env.DENCH_CLOUD_API_KEY?.trim() || process.env.DENCH_API_KEY?.trim()) return "env";
    return "missing";
  })();

  if (!apiKey) {
    return {
      status: "no_key",
      apiKeySource: "missing",
      gatewayUrl,
      primaryModel,
      isDenchPrimary,
      selectedDenchModel: null,
      models: [],
      recommendedModelId: RECOMMENDED_DENCH_CLOUD_MODEL_ID,
    };
  }

  try {
    await validateDenchCloudApiKey(gatewayUrl, apiKey);
  } catch (err) {
    return {
      status: "invalid_key",
      apiKeySource,
      gatewayUrl,
      primaryModel,
      isDenchPrimary,
      selectedDenchModel: null,
      models: [],
      recommendedModelId: RECOMMENDED_DENCH_CLOUD_MODEL_ID,
      validationError: err instanceof Error ? err.message : "API key validation failed.",
    };
  }

  const catalog = await fetchDenchCloudCatalog(gatewayUrl);

  return {
    status: "valid",
    apiKeySource,
    gatewayUrl,
    primaryModel,
    isDenchPrimary,
    selectedDenchModel: settings.selectedModel ?? null,
    models: catalog.models,
    recommendedModelId: RECOMMENDED_DENCH_CLOUD_MODEL_ID,
  };
}

export async function saveApiKey(apiKey: string): Promise<CloudSettingsUpdateResult> {
  const config = readConfig();
  const gatewayUrl = resolveGatewayUrl(config);

  try {
    await validateDenchCloudApiKey(gatewayUrl, apiKey);
  } catch (err) {
    return {
      state: await getCloudSettingsState(),
      changed: false,
      refresh: { attempted: false, restarted: false, error: null, profile: "default" },
      error: err instanceof Error ? err.message : "API key validation failed.",
    };
  }

  const models = ensureRecord(config, "models");
  models.mode = "merge";
  const providers = ensureRecord(models, "providers");
  const denchCloud = ensureRecord(providers, "dench-cloud");
  denchCloud.apiKey = apiKey;

  const catalog = await fetchDenchCloudCatalog(gatewayUrl);
  const patch = buildDenchCloudConfigPatch({
    gatewayUrl,
    apiKey,
    models: catalog.models,
  });

  const patchProvider = asRecord(asRecord(asRecord(patch.models)?.providers)?.["dench-cloud"]);
  if (patchProvider) {
    Object.assign(denchCloud, patchProvider);
  }

  const agents = ensureRecord(config, "agents");
  const defaults = ensureRecord(agents, "defaults");
  const patchAgentModels = asRecord(asRecord(patch.agents)?.defaults);
  if (patchAgentModels?.models) {
    const existingModels = asRecord(defaults.models) ?? {};
    defaults.models = { ...existingModels, ...(asRecord(patchAgentModels.models) ?? {}) };
  }

  writeConfig(config);

  const refresh = await refreshIntegrationsRuntime();
  const state = await getCloudSettingsState();

  return { state, changed: true, refresh };
}

export async function selectModel(stableId: string): Promise<CloudSettingsUpdateResult> {
  const config = readConfig();
  const apiKey = resolveDenchApiKey(config);
  const gatewayUrl = resolveGatewayUrl(config);

  if (!apiKey) {
    return {
      state: await getCloudSettingsState(),
      changed: false,
      refresh: { attempted: false, restarted: false, error: null, profile: "default" },
      error: "No Dench Cloud API key configured.",
    };
  }

  const catalog = await fetchDenchCloudCatalog(gatewayUrl);
  const patch = buildDenchCloudConfigPatch({
    gatewayUrl,
    apiKey,
    models: catalog.models,
  });

  const models = ensureRecord(config, "models");
  models.mode = "merge";
  const providers = ensureRecord(models, "providers");
  const denchCloud = ensureRecord(providers, "dench-cloud");
  const patchProvider = asRecord(asRecord(asRecord(patch.models)?.providers)?.["dench-cloud"]);
  if (patchProvider) {
    Object.assign(denchCloud, patchProvider);
  }

  const agents = ensureRecord(config, "agents");
  const defaults = ensureRecord(agents, "defaults");
  const modelSetting = ensureRecord(defaults, "model");
  modelSetting.primary = `dench-cloud/${stableId}`;

  const patchAgentModels = asRecord(asRecord(patch.agents)?.defaults);
  if (patchAgentModels?.models) {
    const existingModels = asRecord(defaults.models) ?? {};
    defaults.models = { ...existingModels, ...(asRecord(patchAgentModels.models) ?? {}) };
  }

  const messages = ensureRecord(config, "messages");
  const tts = ensureRecord(messages, "tts");
  tts.provider = "elevenlabs";
  const ttsProviders = ensureRecord(tts, "providers");
  ttsProviders.elevenlabs = {
    baseUrl: gatewayUrl,
    apiKey,
  };

  writeConfig(config);

  const refresh = await refreshIntegrationsRuntime();
  const state = await getCloudSettingsState();

  return { state, changed: true, refresh };
}
