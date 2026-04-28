import fs from "node:fs/promises";
import path from "node:path";
import {
  getRuntimeConfig,
  getRuntimeConfigSourceSnapshot,
  projectConfigOntoRuntimeSourceSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { createConfigRuntimeEnv } from "../config/env-vars.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "../plugins/manifest-registry-installed.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { isRecord } from "../utils.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "./agent-scope.js";
import { MODELS_JSON_STATE } from "./models-config-state.js";
import { planOpenClawModelsJson } from "./models-config.plan.js";

export { resetModelsJsonReadyCacheForTest } from "./models-config-state.js";

async function readFileMtimeMs(pathname: string): Promise<number | null> {
  try {
    const stat = await fs.stat(pathname);
    return Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}

async function buildModelsJsonFingerprint(params: {
  config: OpenClawConfig;
  sourceConfigForSecrets: OpenClawConfig;
  agentDir: string;
  workspaceDir?: string;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index">;
  providerDiscoveryProviderIds?: readonly string[];
  providerDiscoveryTimeoutMs?: number;
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
    const raw = await fs.readFile(pathname, "utf8");
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

export async function ensureModelsFileModeForModelsJson(pathname: string): Promise<void> {
  await fs.chmod(pathname, 0o600).catch(() => {
    // best-effort
  });
}

export async function writeModelsFileAtomicForModelsJson(
  targetPath: string,
  contents: string,
): Promise<void> {
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, contents, { mode: 0o600 });
  await fs.rename(tempPath, targetPath);
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

/**
 * Options for ensureOpenClawModelsJson.
 *
 * `targetProvider`/`targetModel` are caller hints for the
 * "short-circuit fast path": when set, the implicit-provider-discovery
 * pipeline can be skipped IF the on-disk models.json provider entry
 * structurally matches what the current configuration would produce
 * (apiKey resolved through env-refs + baseUrl/headers/auth via stable
 * equality).  Any drift falls through to the full plan.
 */
export type EnsureOpenClawModelsJsonOptions = {
  /** Provider id the caller intends to use (e.g. "anthropic", "openai"). */
  targetProvider?: string;
  /** Model id the caller intends to use. Reserved for future refinements. */
  targetModel?: string;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
  workspaceDir?: string;
  providerDiscoveryProviderIds?: readonly string[];
  providerDiscoveryTimeoutMs?: number;
};

/**
 * Resolve a configured provider's `apiKey` reference into the literal
 * value that planOpenClawModelsJson would write to disk, so we can
 * compare config-vs-disk during the short-circuit check.  Mirrors the
 * env-ref handling in `models-config.providers.secret-helpers.ts` but
 * narrowed to the comparison use case.
 *
 * Returns:
 *  - the literal string for plaintext / env-resolved values
 *  - undefined if no apiKey was configured
 *  - null if a secret ref could not be resolved (e.g. env var unset OR
 *    non-env source like keyring; in either case we can't safely match
 *    against disk so the caller should NOT short-circuit)
 */
function resolveConfiguredApiKeyForCompare(
  apiKey: unknown,
  env: NodeJS.ProcessEnv,
): string | null | undefined {
  if (apiKey === undefined) {
    return undefined;
  }
  if (typeof apiKey === "string" && apiKey.length > 0) {
    const ref = resolveSecretInputRef({ value: apiKey }).ref;
    if (!ref || !ref.id.trim()) {
      return apiKey;
    }
    if (ref.source !== "env") {
      return null;
    }
    const value = env[ref.id.trim()];
    return typeof value === "string" && value.length > 0 ? value : null;
  }
  if (isRecord(apiKey)) {
    const ref = resolveSecretInputRef({ value: apiKey, refValue: apiKey }).ref;
    if (!ref || !ref.id.trim()) {
      return null;
    }
    if (ref.source !== "env") {
      return null;
    }
    const value = env[ref.id.trim()];
    return typeof value === "string" && value.length > 0 ? value : null;
  }
  return null;
}

/**
 * Stable comparison of two arbitrary JSON-serializable values via
 * stableStringify.  Used for headers / auth shape equality where a
 * reference-equality or shallow-keys check would miss key-order or
 * nested-shape differences.
 */
function stableEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * Verify that the on-disk models.json provider entry STRUCTURALLY
 * matches what the current configuration would produce.  Used by the
 * short-circuit fast path to skip the implicit-provider-discovery
 * pipeline only when the disk state is provably consistent with config.
 *
 * Compares:
 *   apiKey  — resolved through env-ref expansion before comparing
 *   baseUrl — strict string equality
 *   headers — stable structural equality (key-order independent)
 *   auth    — stable structural equality
 *
 * Any mismatch (or any state we cannot conclusively verify, like a
 * non-env secret ref) returns false so the caller falls through to the
 * full plan + write path.  This closes the "presence-only" check that
 * previously bypassed planning when on-disk credentials were stale or
 * attacker-tampered.
 */
async function readExistingProviderMatchesConfig(
  targetPath: string,
  targetProvider: string,
  configuredProvider: unknown,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (!isRecord(configuredProvider)) {
    return false;
  }
  let raw: string;
  try {
    raw = await fs.readFile(targetPath, "utf8");
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!isRecord(parsed) || !isRecord(parsed.providers)) {
    return false;
  }
  const diskProvider = parsed.providers[targetProvider];
  if (!isRecord(diskProvider)) {
    return false;
  }

  if (
    typeof configuredProvider.baseUrl === "string" &&
    configuredProvider.baseUrl !== diskProvider.baseUrl
  ) {
    return false;
  }

  const resolvedConfiguredApiKey = resolveConfiguredApiKeyForCompare(
    configuredProvider.apiKey,
    env,
  );
  if (resolvedConfiguredApiKey === null) {
    return false;
  }
  if (resolvedConfiguredApiKey !== undefined) {
    if (
      typeof diskProvider.apiKey !== "string" ||
      diskProvider.apiKey !== resolvedConfiguredApiKey
    ) {
      return false;
    }
  } else if (typeof diskProvider.apiKey === "string" && diskProvider.apiKey.length > 0) {
    return false;
  }

  if (!stableEqual(configuredProvider.headers, diskProvider.headers)) {
    return false;
  }
  if (!stableEqual(configuredProvider.auth, diskProvider.auth)) {
    return false;
  }

  return true;
}

export async function ensureOpenClawModelsJson(
  config?: OpenClawConfig,
  agentDirOverride?: string,
  options: EnsureOpenClawModelsJsonOptions = {},
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
    getCurrentPluginMetadataSnapshot({
      config: cfg,
      ...(workspaceDir ? { workspaceDir } : {}),
    });
  const agentDir = agentDirOverride?.trim() ? agentDirOverride.trim() : resolveOpenClawAgentDir();
  const targetPath = path.join(agentDir, "models.json");

  // --- SHORT-CIRCUIT FAST PATH ---
  // If the caller specified a target provider AND the on-disk provider
  // entry STRUCTURALLY matches the current config (apiKey resolved
  // through env-refs, baseUrl/headers/auth via stable equality), skip
  // the implicit-discovery pipeline entirely.  Any drift (rotated key,
  // attacker-tampered baseUrl/headers, missing fields) falls through to
  // full plan + write.
  const targetProvider = options?.targetProvider?.trim();
  if (targetProvider) {
    const explicitProviders = cfg.models?.providers ?? {};
    const configuredProvider = explicitProviders[targetProvider];
    if (configuredProvider) {
      const env = createConfigRuntimeEnv(cfg);
      const matches = await readExistingProviderMatchesConfig(
        targetPath,
        targetProvider,
        configuredProvider,
        env,
      );
      if (matches) {
        await ensureModelsFileModeForModelsJson(targetPath);
        return { agentDir, wrote: false };
      }
    }
  }

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
