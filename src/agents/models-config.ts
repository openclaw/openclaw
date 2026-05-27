import fs from "node:fs/promises";
import path from "node:path";
import {
  getRuntimeConfig,
  getRuntimeConfigSourceSnapshot,
  projectConfigOntoRuntimeSourceSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { createConfigRuntimeEnv } from "../config/env-vars.js";
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
import { listProfilesForProvider } from "./auth-profiles/profile-list.js";
import { updateAuthProfileStoreWithLock } from "./auth-profiles/store.js";
import { MODELS_JSON_STATE } from "./models-config-state.js";
import { isNonSecretApiKeyMarker } from "./model-auth-markers.js";
import { planOpenClawModelsJson } from "./models-config.plan.js";
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

function collectPlaintextApiKeysFromExistingModelsJson(
  existingParsed: unknown,
): Array<{ provider: string; apiKey: string }> {
  if (!existingParsed || typeof existingParsed !== "object" || Array.isArray(existingParsed)) {
    return [];
  }
  const providers = (existingParsed as { providers?: unknown }).providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    return [];
  }
  const keys: Array<{ provider: string; apiKey: string }> = [];
  for (const [provider, entry] of Object.entries(providers)) {
    if (!provider.trim() || !entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const apiKey = (entry as { apiKey?: unknown }).apiKey;
    if (typeof apiKey !== "string") {
      continue;
    }
    const trimmedApiKey = apiKey.trim();
    if (!trimmedApiKey || isNonSecretApiKeyMarker(trimmedApiKey)) {
      continue;
    }
    keys.push({ provider: provider.trim(), apiKey: trimmedApiKey });
  }
  return keys;
}

async function migrateExistingModelsJsonApiKeysToAuthProfiles(params: {
  agentDir: string;
  existingParsed: unknown;
}): Promise<void> {
  const keys = collectPlaintextApiKeysFromExistingModelsJson(params.existingParsed);
  for (const { provider, apiKey } of keys) {
    const migrated = await updateAuthProfileStoreWithLock({
      agentDir: params.agentDir,
      saveOptions: {
        filterExternalAuthProfiles: false,
        syncExternalCli: false,
      },
      updater: (store) => {
        const existingProfileIds = listProfilesForProvider(store, provider);
        if (
          existingProfileIds.some((profileId) => {
            const profile = store.profiles[profileId];
            return profile?.type === "api_key" && profile.key === apiKey;
          })
        ) {
          return false;
        }

        let profileId = `${provider}:models-json`;
        for (let suffix = 2; store.profiles[profileId]; suffix += 1) {
          profileId = `${provider}:models-json-${suffix}`;
        }
        store.profiles[profileId] = {
          type: "api_key",
          provider,
          key: apiKey,
          displayName: "Migrated from models.json",
        };
        store.order = {
          ...store.order,
          [provider]: [profileId, ...(store.order?.[provider] ?? [])],
        };
        return true;
      },
    });
    if (!migrated) {
      throw new Error(
        `Refusing to rewrite models.json before migrating existing plaintext apiKey for provider "${provider}" to auth-profiles.json.`,
      );
    }
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
    await migrateExistingModelsJsonApiKeysToAuthProfiles({
      agentDir,
      existingParsed: existingModelsFile.parsed,
    });
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
