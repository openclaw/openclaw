import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  getRuntimeConfig,
  getRuntimeConfigSourceSnapshot,
  projectConfigOntoRuntimeSourceSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { createConfigRuntimeEnv } from "../config/env-vars.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "../plugins/manifest-registry-installed.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "./agent-scope.js";
import { MODELS_JSON_STATE } from "./models-config-state.js";
import { planOpenClawModelsJson } from "./models-config.plan.js";

export { resetModelsJsonReadyCacheForTest } from "./models-config-state.js";

/**
 * Fields on an auth profile that rotate frequently without changing the
 * shape of what providers are available (OAuth token refreshes,
 * expirations).  We exclude them from the fingerprint so token rotation
 * does not invalidate the implicit-provider-discovery cache.
 */
const AUTH_PROFILE_VOLATILE_FIELDS: ReadonlySet<string> = new Set([
  "access",
  "refresh",
  // "token" is intentionally NOT in this set: profiles with `type: "token"`
  // use the literal `token` key as a long-lived static credential, and
  // stripping it would mask real auth-state changes when a user rotates
  // a static API token.  OAuth session fields ("access"/"refresh") and
  // timing fields below are the only fields that should rotate without
  // invalidating the cache.
  "expires",
  "expiresAt",
  "expiresIn",
  "issuedAt",
  "refreshedAt",
  "lastCheckedAt",
  "lastRefreshAt",
  "lastValidatedAt",
]);

/**
 * Hard cap on the bytes we will read + parse from auth-profiles.json when
 * computing the stable fingerprint hash.  Without a cap, a crafted/large
 * profile file becomes a CPU + memory exhaustion vector via fs.readFile +
 * JSON.parse + recursive walk + stableStringify.  Above the cap we hash
 * raw bytes instead.
 */
const MAX_AUTH_PROFILES_BYTES = 8 * 1024 * 1024;

/**
 * Maximum recursion depth when stripping volatile fields.  Bounds the
 * recursive walk so deeply-nested JSON cannot stack-overflow the gateway
 * during fingerprinting.
 */
const MAX_AUTH_PROFILES_DEPTH = 64;

/**
 * Keys that mutate Object prototype when assigned with bracket syntax,
 * triggering prototype pollution (CWE-1321).  We always skip these when
 * building the stripped fingerprint object even though the result is
 * immediately stable-stringified — defence in depth.
 */
const DANGEROUS_PROTO_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

/**
 * Compute a content-based fingerprint for auth-profiles.json that is
 * stable across OAuth token rotations.  Returns null if the file does
 * not exist; falls back to hashing raw bytes if JSON parsing fails (so
 * structural changes still register, just without canonicalization).
 */
async function readAuthProfilesStableHash(pathname: string): Promise<string | null> {
  // Bound the read by file size before pulling it into memory + parsing.
  // Above the cap we hash raw bytes (already-streamed by readFile) instead
  // of running JSON.parse + the recursive transform.
  const stat = await fs.stat(pathname).catch(() => null);
  if (!stat) {
    return null;
  }
  if (stat.size > MAX_AUTH_PROFILES_BYTES) {
    let raw: Buffer;
    try {
      raw = await fs.readFile(pathname);
    } catch {
      return null;
    }
    return createHash("sha256").update(raw).digest("hex");
  }
  let raw: string;
  try {
    raw = await fs.readFile(pathname, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // File exists but is unparseable; hash the raw bytes so we still
    // detect changes.
    return createHash("sha256").update(raw).digest("hex");
  }
  const stable = stripAuthProfilesVolatileFields(parsed, 0);
  return createHash("sha256").update(stableStringify(stable)).digest("hex");
}

function stripAuthProfilesVolatileFields(value: unknown, depth: number): unknown {
  // Bound recursion to prevent stack overflow on pathologically nested
  // JSON.  At the cap we serialize the subtree as a shallow marker so any
  // change at or below the cap still rolls into the parent's stringification.
  if (depth >= MAX_AUTH_PROFILES_DEPTH) {
    return "[depth-capped]";
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => stripAuthProfilesVolatileFields(entry, depth + 1));
  }
  // Build with Object.create(null) so prototype-mutating keys ("__proto__",
  // "constructor", "prototype") in untrusted input can't pollute the
  // resulting object's prototype chain.  Filter them explicitly too —
  // belt and suspenders (CWE-1321).
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (AUTH_PROFILE_VOLATILE_FIELDS.has(key)) {
      continue;
    }
    if (DANGEROUS_PROTO_KEYS.has(key)) {
      continue;
    }
    result[key] = stripAuthProfilesVolatileFields(entry, depth + 1);
  }
  return result;
}

/**
 * Hash the contents of models.json so external edits / partial corruption /
 * manual tampering invalidate the readyCache.  The fingerprint alone
 * cannot catch external edits because it does not include models.json
 * state (its contents are the OUTPUT, not an input).  Instead we capture
 * a content hash AT WRITE TIME and verify it on every cache hit.
 *
 * Returns null when the file does not exist — the caller treats this as
 * "no captured state" and forces a re-plan.
 */
async function readModelsJsonContentHash(pathname: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(pathname);
    return createHash("sha256").update(raw).digest("hex");
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
  // Use a content-based hash for auth-profiles instead of mtime so OAuth
  // token rotation doesn't invalidate the cache.  models.json drift is
  // tracked separately via modelsJsonHash on the readyCache entry (the
  // file is the output of this function, not an input — including its
  // state in the fingerprint would cause every run to invalidate its
  // own cache).
  const authProfilesHash = await readAuthProfilesStableHash(
    path.join(params.agentDir, "auth-profiles.json"),
  );
  const envShape = createConfigRuntimeEnv(params.config, {});
  const pluginMetadataSnapshotIndexFingerprint = params.pluginMetadataSnapshot
    ? resolveInstalledManifestRegistryIndexFingerprint(params.pluginMetadataSnapshot.index)
    : undefined;
  // Hash the canonical fingerprint payload before returning it so raw
  // config (including apiKey strings) never sits verbatim inside the
  // readyCache.  The cache key only needs to be deterministic, not
  // reversible.  SHA-256 over the stable-stringified payload is
  // collision-resistant for this purpose and the digest is a 64-char
  // hex string with no secret residue (CWE-312 hardening).
  const canonical = stableStringify({
    config: params.config,
    sourceConfigForSecrets: params.sourceConfigForSecrets,
    envShape,
    authProfilesHash,
    workspaceDir: params.workspaceDir,
    pluginMetadataSnapshotIndexFingerprint,
    providerDiscoveryProviderIds: params.providerDiscoveryProviderIds,
    providerDiscoveryTimeoutMs: params.providerDiscoveryTimeoutMs,
  });
  return createHash("sha256").update(canonical).digest("hex");
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
  // CWE-59 (symlink-following chmod) hardening: refuse to chmod a
  // symlink.  fs.chmod follows links, so if an attacker can replace
  // ${agentDir}/models.json with a symlink pointing at a sensitive file
  // owned by the gateway user, this best-effort chmod would change
  // permissions on the link target instead.  lstat first; if the path
  // is a symlink (or anything other than a regular file), bail.
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(pathname);
  } catch {
    return; // best-effort — file may not exist yet
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return;
  }
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

export async function ensureOpenClawModelsJson(
  config?: OpenClawConfig,
  agentDirOverride?: string,
  options: {
    pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
    workspaceDir?: string;
    providerDiscoveryProviderIds?: readonly string[];
    providerDiscoveryTimeoutMs?: number;
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
    const settled = await cached;
    // Two-factor cache hit: the cache key already includes the
    // fingerprint (so different fingerprints get different entries),
    // but we ALSO verify that the on-disk models.json hash still
    // matches what we captured at write time.  File-hash mismatch →
    // someone edited models.json out from under us (manual edit,
    // partial corruption, sibling process), and we must re-plan to
    // restore intended state.
    const currentModelsJsonHash = await readModelsJsonContentHash(targetPath);
    if (currentModelsJsonHash === settled.modelsJsonHash) {
      await ensureModelsFileModeForModelsJson(targetPath);
      return settled.result;
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
      // No write performed; capture whatever's currently on disk so the
      // cache can detect external edits between now and the next call.
      const modelsJsonHash = await readModelsJsonContentHash(targetPath);
      return { fingerprint, modelsJsonHash, result: { agentDir, wrote: false } };
    }

    if (plan.action === "noop") {
      await ensureModelsFileModeForModelsJson(targetPath);
      const modelsJsonHash = await readModelsJsonContentHash(targetPath);
      return { fingerprint, modelsJsonHash, result: { agentDir, wrote: false } };
    }

    await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
    await writeModelsFileAtomicForModelsJson(targetPath, plan.contents);
    await ensureModelsFileModeForModelsJson(targetPath);
    // Capture the post-write hash so subsequent cache checks can detect
    // any external edit / corruption that happens after this point.
    const modelsJsonHash = await readModelsJsonContentHash(targetPath);
    return { fingerprint, modelsJsonHash, result: { agentDir, wrote: true } };
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
        Promise.resolve({
          fingerprint: refreshedFingerprint,
          modelsJsonHash: settled.modelsJsonHash,
          result: settled.result,
        }),
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
