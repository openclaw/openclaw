import fs from "node:fs/promises";
import path from "node:path";
import {
  getRuntimeConfig,
  getRuntimeConfigSourceSnapshot,
  projectConfigOntoRuntimeSourceSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { createConfigRuntimeEnv } from "../config/env-vars.js";
import {
  DEFAULT_SECRET_PROVIDER_ALIAS,
  coerceSecretRef,
  isValidEnvSecretRefId,
} from "../config/types.secrets.js";
import { privateFileStore } from "../infra/private-file-store.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "../plugins/manifest-registry-installed.js";
import {
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";
import {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentDir,
  resolveDefaultAgentId,
} from "./agent-scope.js";
import {
  ensureAuthProfileStore,
  loadAuthProfileStoreForLocalAgent,
  listProfilesForProvider,
  type AuthProfileCredential,
  upsertAuthProfileWithLock,
} from "./auth-profiles.js";
import { isKnownEnvApiKeyMarker, isNonSecretApiKeyMarker } from "./model-auth-markers.js";
import { MODELS_JSON_STATE } from "./models-config-state.js";
import { planOpenClawModelsJson } from "./models-config.plan.js";
import { findNormalizedProviderValue, normalizeProviderId } from "./provider-id.js";
import { stableStringify } from "./stable-stringify.js";

export { resetModelsJsonReadyCacheForTest } from "./models-config-state.js";

async function readFileMtimeMs(pathname: string): Promise<number | null> {
  try {
    const stat = await fs.stat(pathname);
    return Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

async function buildModelsJsonFingerprint(params: {
  config: OpenClawConfig;
  sourceConfigForSecrets: OpenClawConfig;
  agentDir: string;
  workspaceDir?: string;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index">;
  providerDiscoveryProviderIds?: readonly string[];
  providerDiscoveryTimeoutMs?: number;
  providerDiscoveryEntriesOnly?: boolean;
}): Promise<string> {
  const authProfilesMtimeMs = await readFileMtimeMs(
    path.join(params.agentDir, "auth-profiles.json"),
  );
  const modelsFileMtimeMs = await readFileMtimeMs(path.join(params.agentDir, "models.json"));
  const envShape = createConfigRuntimeEnv(params.config, {});
  const pluginMetadataSnapshotIndexFingerprint = params.pluginMetadataSnapshot
    ? resolveInstalledManifestRegistryIndexFingerprint(params.pluginMetadataSnapshot.index)
    : undefined;
  return stableStringify({
    config: params.config,
    sourceConfigForSecrets: params.sourceConfigForSecrets,
    envShape,
    authProfilesMtimeMs,
    modelsFileMtimeMs,
    workspaceDir: params.workspaceDir,
    pluginMetadataSnapshotIndexFingerprint,
    providerDiscoveryProviderIds: params.providerDiscoveryProviderIds,
    providerDiscoveryTimeoutMs: params.providerDiscoveryTimeoutMs,
    providerDiscoveryEntriesOnly: params.providerDiscoveryEntriesOnly === true,
  });
}

function modelsJsonReadyCacheKey(targetPath: string, fingerprint: string): string {
  return `${targetPath}\0${fingerprint}`;
}

async function readExistingModelsFile(pathname: string): Promise<{
  raw: string;
  parsed: unknown;
}> {
  try {
    const raw = await privateFileStore(path.dirname(pathname)).readTextIfExists(
      path.basename(pathname),
    );
    if (raw === null) {
      return {
        raw: "",
        parsed: null,
      };
    }
    return {
      raw,
      parsed: JSON.parse(raw) as unknown,
    };
  } catch {
    return {
      raw: "",
      parsed: null,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeOptionalSecretValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const collapsed = value.replace(/[\r\n\u2028\u2029]+/g, "");
  let latin1Only = "";
  for (const char of collapsed) {
    const codePoint = char.codePointAt(0);
    if (typeof codePoint === "number" && codePoint <= 0xff) {
      latin1Only += char;
    }
  }
  const normalized = latin1Only.trim();
  return normalized ? normalized : undefined;
}

function resolveProviderCatalog(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.providers)) {
    return {};
  }
  return value.providers;
}

function resolveMigratableProviderApiKey(provider: unknown): string | undefined {
  if (!isRecord(provider) || typeof provider.apiKey !== "string") {
    return undefined;
  }
  const apiKey = provider.apiKey.trim();
  if (!apiKey) {
    return undefined;
  }
  if (isKnownEnvApiKeyMarker(apiKey)) {
    return apiKey;
  }
  if (isNonSecretApiKeyMarker(apiKey, { includeEnvVarName: false })) {
    return undefined;
  }
  return apiKey;
}

function hasConfiguredProviderApiKey(cfg: OpenClawConfig, providerKey: string): boolean {
  const provider = findNormalizedProviderValue(cfg.models?.providers, providerKey);
  if (!isRecord(provider)) {
    return false;
  }
  return (
    normalizeOptionalSecretValue(provider.apiKey) !== undefined ||
    coerceSecretRef(provider.apiKey) !== null
  );
}

function resolveMigratedModelsJsonProfileId(providerKey: string): string {
  const normalized = normalizeProviderId(providerKey)
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${normalized || "provider"}:models-json`;
}

function resolveMigratedModelsJsonApiKeyCredential(
  providerKey: string,
  existingApiKey: string,
  env: NodeJS.ProcessEnv,
): AuthProfileCredential {
  const base = {
    type: "api_key",
    provider: providerKey,
    copyToAgents: false,
    displayName: "Migrated from models.json",
  } as const;
  if (
    isKnownEnvApiKeyMarker(existingApiKey) ||
    (isValidEnvSecretRefId(existingApiKey) &&
      normalizeOptionalSecretValue(env[existingApiKey]) !== undefined)
  ) {
    return {
      ...base,
      keyRef: {
        source: "env",
        provider: DEFAULT_SECRET_PROVIDER_ALIAS,
        id: existingApiKey,
      },
    };
  }
  return {
    ...base,
    key: existingApiKey,
  };
}

async function migrateExistingModelsJsonOnlyProviderApiKeys(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  env: NodeJS.ProcessEnv;
  existingParsed: unknown;
  nextContents: string;
}): Promise<void> {
  const existingProviders = resolveProviderCatalog(params.existingParsed);
  if (Object.keys(existingProviders).length === 0) {
    return;
  }

  let nextProviders: Record<string, unknown>;
  try {
    nextProviders = resolveProviderCatalog(JSON.parse(params.nextContents) as unknown);
  } catch {
    return;
  }

  const candidates = Object.entries(existingProviders).flatMap(
    ([providerKey, existingProvider]) => {
      const existingApiKey = resolveMigratableProviderApiKey(existingProvider);
      if (!existingApiKey) {
        return [];
      }
      if (hasConfiguredProviderApiKey(params.cfg, providerKey)) {
        return [];
      }
      if (resolveMigratableProviderApiKey(nextProviders[providerKey])) {
        return [];
      }
      return [{ providerKey, existingApiKey }];
    },
  );

  if (candidates.length === 0) {
    return;
  }

  const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
  const localStore = loadAuthProfileStoreForLocalAgent(params.agentDir, {
    allowKeychainPrompt: false,
    resolveLegacyOAuthSidecars: false,
  });
  for (const { providerKey, existingApiKey } of candidates) {
    if (listProfilesForProvider(localStore, providerKey).length > 0) {
      continue;
    }

    const profileId = resolveMigratedModelsJsonProfileId(providerKey);
    const credential = resolveMigratedModelsJsonApiKeyCredential(
      providerKey,
      existingApiKey,
      params.env,
    );
    const updatedStore = await upsertAuthProfileWithLock({
      agentDir: params.agentDir,
      profileId,
      credential,
    });
    if (updatedStore === null) {
      throw new Error(
        `Failed to migrate existing models.json provider apiKey for ${providerKey}; keeping existing models.json unchanged`,
      );
    }
    store.profiles[profileId] = credential;
    localStore.profiles[profileId] = credential;
  }
}

export async function ensureModelsFileModeForModelsJson(pathname: string): Promise<void> {
  await fs.chmod(pathname, 0o600).catch(() => {
    // best-effort
  });
}

export async function writeModelsFileAtomicForModelsJson(
  targetPath: string,
  contents: string,
): Promise<void> {
  await privateFileStore(path.dirname(targetPath)).writeText(path.basename(targetPath), contents);
}

function resolveModelsConfigInput(config?: OpenClawConfig): {
  config: OpenClawConfig;
  sourceConfigForSecrets: OpenClawConfig;
} {
  const runtimeSource = getRuntimeConfigSourceSnapshot();
  if (!config) {
    const loaded = getRuntimeConfig();
    return {
      config: runtimeSource ?? loaded,
      sourceConfigForSecrets: runtimeSource ?? loaded,
    };
  }
  if (!runtimeSource) {
    return {
      config,
      sourceConfigForSecrets: config,
    };
  }
  const projected = projectConfigOntoRuntimeSourceSnapshot(config);
  return {
    config: projected,
    // If projection is skipped (for example incompatible top-level shape),
    // keep managed secret persistence anchored to the active source snapshot.
    sourceConfigForSecrets: projected === config ? runtimeSource : projected,
  };
}

async function withModelsJsonWriteLock<T>(targetPath: string, run: () => Promise<T>): Promise<T> {
  const prior = MODELS_JSON_STATE.writeLocks.get(targetPath) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = prior.then(() => gate);
  MODELS_JSON_STATE.writeLocks.set(targetPath, pending);
  try {
    await prior;
    return await run();
  } finally {
    release();
    if (MODELS_JSON_STATE.writeLocks.get(targetPath) === pending) {
      MODELS_JSON_STATE.writeLocks.delete(targetPath);
    }
  }
}

export async function ensureOpenClawModelsJson(
  config?: OpenClawConfig,
  agentDirOverride?: string,
  options: {
    pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
    workspaceDir?: string;
    providerDiscoveryProviderIds?: readonly string[];
    providerDiscoveryTimeoutMs?: number;
    providerDiscoveryEntriesOnly?: boolean;
  } = {},
): Promise<{ agentDir: string; wrote: boolean }> {
  const resolved = resolveModelsConfigInput(config);
  const cfg = resolved.config;
  const workspaceDir =
    options.workspaceDir ??
    (agentDirOverride?.trim()
      ? undefined
      : resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)));
  const pluginMetadataSnapshot =
    options.pluginMetadataSnapshot ??
    resolvePluginMetadataSnapshot({
      config: cfg,
      env: createConfigRuntimeEnv(cfg),
      ...(workspaceDir ? { workspaceDir } : {}),
      allowWorkspaceScopedCurrent: workspaceDir === undefined,
    });
  const agentDir = agentDirOverride?.trim() ? agentDirOverride.trim() : resolveDefaultAgentDir(cfg);
  const targetPath = path.join(agentDir, "models.json");
  const fingerprint = await buildModelsJsonFingerprint({
    config: cfg,
    sourceConfigForSecrets: resolved.sourceConfigForSecrets,
    agentDir,
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
    ...(options.providerDiscoveryProviderIds
      ? { providerDiscoveryProviderIds: options.providerDiscoveryProviderIds }
      : {}),
    ...(options.providerDiscoveryTimeoutMs !== undefined
      ? { providerDiscoveryTimeoutMs: options.providerDiscoveryTimeoutMs }
      : {}),
    ...(options.providerDiscoveryEntriesOnly === true
      ? { providerDiscoveryEntriesOnly: true }
      : {}),
  });
  const cacheKey = modelsJsonReadyCacheKey(targetPath, fingerprint);
  const cached = MODELS_JSON_STATE.readyCache.get(cacheKey);
  if (cached) {
    const settled = await cached;
    await ensureModelsFileModeForModelsJson(targetPath);
    return settled.result;
  }

  const pending = withModelsJsonWriteLock(targetPath, async () => {
    // Ensure config env vars (e.g. AWS_PROFILE, AWS_ACCESS_KEY_ID) are
    // are available to provider discovery without mutating process.env.
    const env = createConfigRuntimeEnv(cfg);
    const existingModelsFile = await readExistingModelsFile(targetPath);
    const plan = await planOpenClawModelsJson({
      cfg,
      sourceConfigForSecrets: resolved.sourceConfigForSecrets,
      agentDir,
      env,
      ...(workspaceDir ? { workspaceDir } : {}),
      existingRaw: existingModelsFile.raw,
      existingParsed: existingModelsFile.parsed,
      ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
      ...(options.providerDiscoveryProviderIds
        ? { providerDiscoveryProviderIds: options.providerDiscoveryProviderIds }
        : {}),
      ...(options.providerDiscoveryTimeoutMs !== undefined
        ? { providerDiscoveryTimeoutMs: options.providerDiscoveryTimeoutMs }
        : {}),
      ...(options.providerDiscoveryEntriesOnly === true
        ? { providerDiscoveryEntriesOnly: true }
        : {}),
    });

    if (plan.action === "skip") {
      return { fingerprint, result: { agentDir, wrote: false } };
    }

    if (plan.action === "noop") {
      await ensureModelsFileModeForModelsJson(targetPath);
      return { fingerprint, result: { agentDir, wrote: false } };
    }

    await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
    await migrateExistingModelsJsonOnlyProviderApiKeys({
      cfg,
      agentDir,
      env,
      existingParsed: existingModelsFile.parsed,
      nextContents: plan.contents,
    });
    await writeModelsFileAtomicForModelsJson(targetPath, plan.contents);
    await ensureModelsFileModeForModelsJson(targetPath);
    return { fingerprint, result: { agentDir, wrote: true } };
  });
  MODELS_JSON_STATE.readyCache.set(cacheKey, pending);
  try {
    const settled = await pending;
    const refreshedFingerprint = await buildModelsJsonFingerprint({
      config: cfg,
      sourceConfigForSecrets: resolved.sourceConfigForSecrets,
      agentDir,
      ...(workspaceDir ? { workspaceDir } : {}),
      ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
      ...(options.providerDiscoveryProviderIds
        ? { providerDiscoveryProviderIds: options.providerDiscoveryProviderIds }
        : {}),
      ...(options.providerDiscoveryTimeoutMs !== undefined
        ? { providerDiscoveryTimeoutMs: options.providerDiscoveryTimeoutMs }
        : {}),
      ...(options.providerDiscoveryEntriesOnly === true
        ? { providerDiscoveryEntriesOnly: true }
        : {}),
    });
    const refreshedCacheKey = modelsJsonReadyCacheKey(targetPath, refreshedFingerprint);
    if (refreshedCacheKey !== cacheKey) {
      MODELS_JSON_STATE.readyCache.delete(cacheKey);
      MODELS_JSON_STATE.readyCache.set(
        refreshedCacheKey,
        Promise.resolve({ fingerprint: refreshedFingerprint, result: settled.result }),
      );
    }
    return settled.result;
  } catch (error) {
    if (MODELS_JSON_STATE.readyCache.get(cacheKey) === pending) {
      MODELS_JSON_STATE.readyCache.delete(cacheKey);
    }
    throw error;
  }
}
