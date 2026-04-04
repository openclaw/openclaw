import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveOpenClawStateDir } from "@/lib/workspace";
import {
  type DenchCloudCatalogModel,
  DEFAULT_DENCH_CLOUD_GATEWAY_URL,
  normalizeDenchGatewayUrl,
  fetchDenchCloudCatalog,
  validateDenchCloudApiKey,
  buildDenchCloudConfigPatch,
  readConfiguredDenchCloudSettings,
  RECOMMENDED_DENCH_CLOUD_MODEL_ID,
} from "../../../src/cli/dench-cloud";
import {
  rebuildComposioToolIndexIfReady,
  type RebuildComposioToolIndexResult,
} from "./composio-tool-index";
import { refreshIntegrationsRuntime, type IntegrationRuntimeRefresh } from "./integrations";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

function readElevenLabsProvider(config: UnknownRecord): UnknownRecord | undefined {
  return asRecord(asRecord(asRecord(config.messages)?.tts)?.providers)?.elevenlabs as UnknownRecord | undefined;
}

function readSelectedVoiceId(config: UnknownRecord): string | null {
  return readString(readElevenLabsProvider(config)?.voiceId);
}

function isElevenLabsEnabled(config: UnknownRecord): boolean {
  const tts = asRecord(asRecord(config.messages)?.tts);
  const elevenlabs = readElevenLabsProvider(config);
  return readString(tts?.provider) === "elevenlabs"
    && Boolean(readString(elevenlabs?.baseUrl))
    && Boolean(readString(elevenlabs?.apiKey));
}

function syncEnabledElevenLabsCredentials(
  config: UnknownRecord,
  params: { gatewayUrl: string; apiKey: string },
): void {
  const messages = ensureRecord(config, "messages");
  const tts = ensureRecord(messages, "tts");
  if (tts.provider !== "elevenlabs") {
    return;
  }
  const providers = ensureRecord(tts, "providers");
  const elevenlabs = ensureRecord(providers, "elevenlabs");
  elevenlabs.baseUrl = params.gatewayUrl;
  elevenlabs.apiKey = params.apiKey;
}

function setSelectedVoiceId(config: UnknownRecord, voiceId: string | null): void {
  const messages = ensureRecord(config, "messages");
  const tts = ensureRecord(messages, "tts");
  const providers = ensureRecord(tts, "providers");
  const elevenlabs = ensureRecord(providers, "elevenlabs");
  if (voiceId) {
    elevenlabs.voiceId = voiceId;
  } else {
    delete elevenlabs.voiceId;
    if (Object.keys(elevenlabs).length === 0) {
      delete providers.elevenlabs;
    }
  }
}

export type CloudSettingsStatus = "no_key" | "invalid_key" | "valid";

export type CloudVoiceState = {
  status: CloudSettingsStatus;
  apiKeySource: "config" | "env" | "missing";
  gatewayUrl: string;
  apiKey: string | null;
  selectedVoiceId: string | null;
  elevenLabsEnabled: boolean;
  validationError?: string;
};

export type CloudSettingsState = {
  status: CloudSettingsStatus;
  apiKeySource: "config" | "env" | "missing";
  gatewayUrl: string;
  primaryModel: string | null;
  isDenchPrimary: boolean;
  selectedDenchModel: string | null;
  selectedVoiceId: string | null;
  elevenLabsEnabled: boolean;
  models: DenchCloudCatalogModel[];
  recommendedModelId: string;
  validationError?: string;
};

export type CloudSettingsUpdateResult = {
  state: CloudSettingsState;
  changed: boolean;
  refresh: IntegrationRuntimeRefresh;
  toolIndexRebuild?: RebuildComposioToolIndexResult;
  error?: string;
};

async function rebuildComposioToolIndexBestEffort(): Promise<RebuildComposioToolIndexResult> {
  try {
    return await rebuildComposioToolIndexIfReady();
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "Failed to rebuild Composio tool index.",
    };
  }
}

export async function getCloudVoiceState(): Promise<CloudVoiceState> {
  const config = readConfig();
  const apiKey = resolveDenchApiKey(config);
  const gatewayUrl = resolveGatewayUrl(config);
  const selectedVoiceId = readSelectedVoiceId(config);
  const elevenLabsEnabled = isElevenLabsEnabled(config);

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
      apiKey: null,
      selectedVoiceId,
      elevenLabsEnabled,
    };
  }

  try {
    await validateDenchCloudApiKey(gatewayUrl, apiKey);
  } catch (err) {
    return {
      status: "invalid_key",
      apiKeySource,
      gatewayUrl,
      apiKey,
      selectedVoiceId,
      elevenLabsEnabled,
      validationError: err instanceof Error ? err.message : "API key validation failed.",
    };
  }

  return {
    status: "valid",
    apiKeySource,
    gatewayUrl,
    apiKey,
    selectedVoiceId,
    elevenLabsEnabled,
  };
}

export async function getCloudSettingsState(): Promise<CloudSettingsState> {
  const config = readConfig();
  const primaryModel = resolvePrimaryModel(config);
  const isDenchPrimary = Boolean(primaryModel?.startsWith("dench-cloud/"));
  const settings = readConfiguredDenchCloudSettings(config);
  const voiceState = await getCloudVoiceState();

  if (voiceState.status === "no_key") {
    return {
      status: "no_key",
      apiKeySource: "missing",
      gatewayUrl: voiceState.gatewayUrl,
      primaryModel,
      isDenchPrimary,
      selectedDenchModel: null,
      selectedVoiceId: voiceState.selectedVoiceId,
      elevenLabsEnabled: voiceState.elevenLabsEnabled,
      models: [],
      recommendedModelId: RECOMMENDED_DENCH_CLOUD_MODEL_ID,
    };
  }

  if (voiceState.status === "invalid_key") {
    return {
      status: "invalid_key",
      apiKeySource: voiceState.apiKeySource,
      gatewayUrl: voiceState.gatewayUrl,
      primaryModel,
      isDenchPrimary,
      selectedDenchModel: null,
      selectedVoiceId: voiceState.selectedVoiceId,
      elevenLabsEnabled: voiceState.elevenLabsEnabled,
      models: [],
      recommendedModelId: RECOMMENDED_DENCH_CLOUD_MODEL_ID,
      validationError: voiceState.validationError,
    };
  }

  const catalog = await fetchDenchCloudCatalog(voiceState.gatewayUrl);

  return {
    status: "valid",
    apiKeySource: voiceState.apiKeySource,
    gatewayUrl: voiceState.gatewayUrl,
    primaryModel,
    isDenchPrimary,
    selectedDenchModel: settings.selectedModel ?? null,
    selectedVoiceId: voiceState.selectedVoiceId,
    elevenLabsEnabled: voiceState.elevenLabsEnabled,
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

  syncEnabledElevenLabsCredentials(config, { gatewayUrl, apiKey });

  const patchMcp = asRecord((patch as UnknownRecord).mcp);
  if (patchMcp) {
    const mcp = ensureRecord(config, "mcp");
    const servers = ensureRecord(mcp, "servers");
    const patchServers = asRecord(patchMcp.servers);
    if (patchServers) {
      Object.assign(servers, patchServers);
    }
  }

  writeConfig(config);

  const toolIndexRebuild = await rebuildComposioToolIndexBestEffort();
  const refresh = await refreshIntegrationsRuntime();
  const state = await getCloudSettingsState();

  return { state, changed: true, refresh, toolIndexRebuild };
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
  syncEnabledElevenLabsCredentials(config, { gatewayUrl, apiKey });

  const patchMcp = asRecord((patch as UnknownRecord).mcp);
  if (patchMcp) {
    const mcp = ensureRecord(config, "mcp");
    const servers = ensureRecord(mcp, "servers");
    const patchServers = asRecord(patchMcp.servers);
    if (patchServers) {
      Object.assign(servers, patchServers);
    }
  }

  writeConfig(config);

  const toolIndexRebuild = await rebuildComposioToolIndexBestEffort();
  const refresh = await refreshIntegrationsRuntime();
  const state = await getCloudSettingsState();

  return { state, changed: true, refresh, toolIndexRebuild };
}

export async function saveVoiceId(voiceId: string | null): Promise<CloudSettingsUpdateResult> {
  const config = readConfig();
  const nextVoiceId = voiceId?.trim() || null;
  const currentVoiceId = readSelectedVoiceId(config);
  const refresh = { attempted: false, restarted: false, error: null, profile: "default" } as const;

  if (currentVoiceId === nextVoiceId) {
    return {
      state: await getCloudSettingsState(),
      changed: false,
      refresh,
    };
  }

  setSelectedVoiceId(config, nextVoiceId);
  writeConfig(config);

  return {
    state: await getCloudSettingsState(),
    changed: true,
    refresh,
  };
}
