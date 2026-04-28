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
 * Resolve a configured provider's `apiKey` reference into the form that
 * planOpenClawModelsJson actually writes to disk, so we can compare
 * config-vs-disk during the short-circuit check.
 *
 * IMPORTANT: env-ref API keys are persisted to models.json as the
 * env-var **NAME** (e.g. `"OPENAI_API_KEY"`), not the env-var value.
 * That's the form `resolveApiKeyFromCredential` produces for env-source
 * credentials and the form the rest of the runtime expects.  Comparing
 * against the resolved value would always mismatch and silently skip
 * the short-circuit on every call (Codex P2 on PR #73261).
 *
 * The env var is only consulted to verify it's currently set — if the
 * variable is missing or empty, no usable credential exists and the
 * caller should fall through to full planning rather than short-circuit.
 *
 * Returns:
 *  - the env-var name for env-source secret refs
 *  - the literal string for plaintext values
 *  - undefined if no apiKey was configured
 *  - null if a secret ref could not be resolved (env var unset OR
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
      // Plaintext literal value — disk holds the same literal.
      return apiKey;
    }
    if (ref.source !== "env") {
      return null;
    }
    // Env source: disk holds the env var NAME, not the value.  Verify
    // the env is currently populated so we don't short-circuit on a
    // misconfigured environment, but compare against the var name.
    const id = ref.id.trim();
    const value = env[id];
    return typeof value === "string" && value.length > 0 ? id : null;
  }
  if (isRecord(apiKey)) {
    const ref = resolveSecretInputRef({ value: apiKey, refValue: apiKey }).ref;
    if (!ref || !ref.id.trim()) {
      return null;
    }
    if (ref.source !== "env") {
      return null;
    }
    const id = ref.id.trim();
    const value = env[id];
    return typeof value === "string" && value.length > 0 ? id : null;
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
 * Hard cap on the bytes we will read + parse from models.json during
 * the short-circuit check (Aisle medium #4 on PR #73261).  Realistic
 * models.json sizes are dominated by listed models per provider; 1 MiB
 * is plenty of headroom while bounding the worst-case allocation.
 */
const MAX_MODELS_JSON_SHORT_CIRCUIT_BYTES = 1 * 1024 * 1024;

/**
 * Verify that the on-disk models.json provider entry STRUCTURALLY
 * matches what the current configuration would produce.  Used by the
 * short-circuit fast path to skip the implicit-provider-discovery
 * pipeline only when the disk state is provably consistent with config.
 *
 * Compares (all symmetric — either side undefined != string is a
 * mismatch):
 *   apiKey  — resolved through env-ref expansion before comparing
 *             (env-source values compare by env-var NAME, not value,
 *             since that's what plan writes to disk)
 *   baseUrl — stable structural equality (closes asymmetric-undef bug)
 *   headers — stable structural equality
 *   auth    — stable structural equality
 *
 * Other provider fields (models[], maxTokens, contextWindow, cost,
 * compat, etc.) are NOT compared.  Tampering with those would not
 * cause SSRF / credential exfil but might change inference behaviour;
 * accepting that trade-off keeps the short-circuit reachable.  If a
 * field becomes security-critical later, add it here.
 *
 * Any mismatch (or any state we cannot conclusively verify, like a
 * non-env secret ref) returns false so the caller falls through to
 * the full plan + write path.
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
  // Reject prototype-chain key collisions for targetProvider (Aisle
  // medium #3 on PR #73261).  String keys like "__proto__" /
  // "constructor" / "prototype" should not steer the short-circuit.
  if (
    targetProvider === "__proto__" ||
    targetProvider === "constructor" ||
    targetProvider === "prototype"
  ) {
    return false;
  }
  // Symlink-safe + size-capped read (Aisle medium #2 + #4).  Refuses
  // symlinks, non-regular files, and files larger than the cap.
  const lst = await fs.lstat(targetPath).catch(() => null);
  if (!lst || lst.isSymbolicLink() || !lst.isFile()) {
    return false;
  }
  if (lst.size > MAX_MODELS_JSON_SHORT_CIRCUIT_BYTES) {
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
  // Use Object.hasOwn to refuse inherited keys — belt-and-suspenders
  // against prototype-chain access (Aisle medium #3).
  if (!Object.hasOwn(parsed.providers, targetProvider)) {
    return false;
  }
  const diskProvider = parsed.providers[targetProvider];
  if (!isRecord(diskProvider)) {
    return false;
  }

  // Symmetric baseUrl comparison.  The previous asymmetric check
  // (`typeof configuredProvider.baseUrl === "string" && ... !== ...`)
  // skipped validation entirely when config omitted baseUrl, letting
  // an attacker-injected disk baseUrl slip through (Greptile P1
  // security + Aisle High #1 on PR #73261).  Now: any difference
  // between configured and disk baseUrl — including config-undefined
  // vs disk-string — falls through to full planning, which will
  // re-apply provider/plugin defaults and rewrite the file.
  if (!stableEqual(configuredProvider.baseUrl, diskProvider.baseUrl)) {
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
    // Warm in-memory cache hit: same inputs, already-planned result.
    // This is the fastest path — no disk I/O at all.
    const settled = await cached;
    await ensureModelsFileModeForModelsJson(targetPath);
    return settled.result;
  }

  // --- TARGETPROVIDER SHORT-CIRCUIT FAST PATH ---
  // The fingerprint cache missed (cold start, gateway restart, or
  // input drift), but the caller hinted which provider it intends to
  // use.  If the on-disk provider entry STRUCTURALLY matches the
  // current config (apiKey env-var name, baseUrl, headers, auth all
  // identical), skip the heavy implicit-discovery pipeline.  Any
  // drift (rotated key, attacker-tampered baseUrl/headers, missing
  // fields) falls through to full plan + write.
  //
  // Order matters: we run AFTER the readyCache check so warm callers
  // skip the disk read entirely.  We also POPULATE the readyCache
  // after a successful short-circuit so subsequent calls hit the
  // in-memory path instead of repeating the disk + parse work
  // (Greptile P2 on PR #73261).
  const targetProvider = options?.targetProvider?.trim();
  if (targetProvider) {
    const explicitProviders = cfg.models?.providers ?? {};
    const configuredProvider = Object.hasOwn(explicitProviders, targetProvider)
      ? explicitProviders[targetProvider]
      : undefined;
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
        const result = { agentDir, wrote: false };
        // Populate readyCache so the next call with identical inputs
        // takes the warm-cache path above without re-reading disk.
        MODELS_JSON_STATE.readyCache.set(cacheKey, Promise.resolve({ fingerprint, result }));
        return result;
      }
    }
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
