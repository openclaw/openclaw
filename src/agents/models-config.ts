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
import { isRecord } from "../utils.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "./agent-scope.js";
import { MODELS_JSON_STATE } from "./models-config-state.js";
import { planOpenClawModelsJson } from "./models-config.plan.js";

export { resetModelsJsonReadyCacheForTest } from "./models-config-state.js";

/**
 * Fields on an auth profile that rotate frequently without changing the
 * shape of what providers are available (OAuth token refreshes, expirations).
 * We exclude them from the fingerprint so token rotation does not invalidate
 * the implicit-provider-discovery cache.
 */
const AUTH_PROFILE_VOLATILE_FIELDS: ReadonlySet<string> = new Set([
  "access",
  "refresh",
  // NOTE: "token" was previously stripped as a volatile field, but profiles
  // with `type: "token"` use the literal `token` key as a long-lived
  // credential identifier (Greptile P2 / Codex P2 on PR #72869). Stripping
  // it would mask real auth-state changes — e.g. user rotates a static
  // API token but the cached fingerprint stays identical, so the
  // implicit-provider-discovery pipeline never re-runs. Keep the OAuth
  // session fields above ("access"/"refresh") and the timing fields below,
  // but treat "token" as significant content.
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
 * computing the stable fingerprint hash (Aisle medium #4 on PR #72869).
 * Without a cap, a crafted/large profile file becomes a CPU + memory
 * exhaustion vector via fs.readFile + JSON.parse + recursive walk +
 * stableStringify. 8 MiB is far above any plausible legitimate auth-
 * profiles size and still bounds the worst-case allocation.
 */
const MAX_AUTH_PROFILES_BYTES = 8 * 1024 * 1024;

/**
 * Maximum recursion depth when stripping volatile fields. Bounds the
 * recursive walk so deeply-nested JSON cannot stack-overflow the gateway
 * during fingerprinting (Aisle medium #4).
 */
const MAX_AUTH_PROFILES_DEPTH = 64;

/**
 * Keys that mutate Object prototype when assigned with bracket syntax,
 * triggering prototype pollution (CWE-1321). We always skip these when
 * building the stripped fingerprint object even though the result is
 * immediately stable-stringified — defence in depth (Aisle medium #3).
 */
const DANGEROUS_PROTO_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

/**
 * Compute a content-based fingerprint for a JSON file whose mtime may
 * change without meaningful content change (e.g. auth-profiles.json rewritten
 * by OAuth token refresh).
 *
 * Returns null if the file does not exist or cannot be parsed; returns the
 * file's raw SHA-256 hash as a fallback if JSON parsing fails but the file
 * exists.
 */
async function readAuthProfilesStableHash(pathname: string): Promise<string | null> {
  // Aisle medium #4: bound the read by file size before pulling it into
  // memory + JSON.parse + recursive walk. Above the cap we hash the raw
  // bytes (already-streamed by readFile, but at least we avoid the
  // recursive transform / stringify cost) instead of the parsed shape.
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
    // File exists but is unparseable; hash the raw bytes so we still detect
    // changes, but avoid using mtime.
    return createHash("sha256").update(raw).digest("hex");
  }
  const stable = stripAuthProfilesVolatileFields(parsed, 0);
  return createHash("sha256").update(stableStringify(stable)).digest("hex");
}

function stripAuthProfilesVolatileFields(value: unknown, depth: number): unknown {
  // Aisle medium #4: bound recursion to prevent stack overflow on
  // pathologically nested JSON. At the cap we serialize the subtree as a
  // shallow marker; this still produces a stable hash (any change at or
  // below the cap rolls into the parent's stringification).
  if (depth >= MAX_AUTH_PROFILES_DEPTH) {
    return "[depth-capped]";
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => stripAuthProfilesVolatileFields(entry, depth + 1));
  }
  // Aisle medium #3: build with Object.create(null) so prototype-mutating
  // keys ("__proto__", "constructor", "prototype") in untrusted input
  // can't pollute the resulting object's prototype chain. Filter them
  // explicitly too — belt and suspenders.
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
}): Promise<string> {
  // Hash auth-profiles.json contents (stripped of volatile OAuth fields) so
  // that token rotation does not invalidate the implicit-provider-discovery
  // cache but structural changes (added/removed profiles) still do.
  //
  // We intentionally do NOT include models.json state here. Its contents are
  // the OUTPUT of this function, not an input to it. Including models.json
  // state caused every run to observe its own write and invalidate the cache
  // on the next call. External edits to models.json are still handled by the
  // plan layer, which compares existing file contents against the computed
  // plan and rewrites only on real drift.
  const authProfilesHash = await readAuthProfilesStableHash(
    path.join(params.agentDir, "auth-profiles.json"),
  );
  const envShape = createConfigRuntimeEnv(params.config, {});
  const pluginMetadataSnapshotIndexFingerprint = params.pluginMetadataSnapshot
    ? resolveInstalledManifestRegistryIndexFingerprint(params.pluginMetadataSnapshot.index)
    : undefined;
  return stableStringify({
    config: params.config,
    sourceConfigForSecrets: params.sourceConfigForSecrets,
    envShape,
    authProfilesHash,
    workspaceDir: params.workspaceDir,
    pluginMetadataSnapshotIndexFingerprint,
  });
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
  // Aisle high #1 on PR #72869 (CWE-59 symlink-following chmod): refuse to
  // chmod a symlink. fs.chmod follows links, so if an attacker can replace
  // ${agentDir}/models.json with a symlink pointing at a sensitive file
  // owned by the gateway user, this best-effort chmod would change
  // permissions on the link target instead. lstat first; if the path is a
  // symlink (or anything other than a regular file), bail.
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(pathname);
  } catch {
    return; // best-effort — file may not exist yet
  }
  if (stat.isSymbolicLink()) {
    return;
  }
  if (!stat.isFile()) {
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

/**
 * Optional hints the caller may pass to short-circuit work when it already
 * knows the exact provider/model it wants. When set AND the requested
 * provider is already fully configured in models.json with a usable apiKey
 * or auth, the plugin-discovery pipeline is skipped entirely (saving several
 * seconds on cache-miss calls).
 */
export type EnsureOpenClawModelsJsonOptions = {
  /** Provider id the caller intends to use (e.g. "anthropic", "openai"). */
  targetProvider?: string;
  /** Model id the caller intends to use. Reserved for future refinements. */
  targetModel?: string;
  /**
   * Optional plugin metadata snapshot. When omitted, the global current
   * snapshot is consulted via getCurrentPluginMetadataSnapshot(). The
   * fingerprint of the installed-manifest-registry index is folded into
   * the cache key so plugin install/uninstall invalidates cached results.
   */
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
  /** Workspace directory for resolving workspace-scoped agent state. */
  workspaceDir?: string;
};

/**
 * Inspect on-disk models.json to see if the requested provider is already
 * present with functional credentials. Used for the short-circuit fast path.
 */
async function readExistingProviderIsConfigured(
  targetPath: string,
  targetProvider: string,
): Promise<boolean> {
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
  const provider = parsed.providers[targetProvider];
  if (!isRecord(provider)) {
    return false;
  }
  // Must have some form of usable credential material. We accept either a
  // non-empty apiKey or a non-empty headers map or explicit auth config — any
  // of these indicates the provider row is fully populated and usable by the
  // pi-embedded runner without a fresh discovery pass.
  const apiKey = provider.apiKey;
  if (typeof apiKey === "string" && apiKey.length > 0) {
    return true;
  }
  if (isRecord(apiKey) && Object.keys(apiKey).length > 0) {
    // Unresolved secret ref — provider row exists but secret isn't baked yet.
    // Be conservative: this still means the shape is stable, so short-circuit.
    return true;
  }
  if (isRecord(provider.headers) && Object.keys(provider.headers).length > 0) {
    return true;
  }
  if (provider.auth !== undefined) {
    return true;
  }
  return false;
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
  // If the caller specified a target provider and that provider is already
  // configured in both the in-memory config AND the on-disk models.json, we
  // can skip the entire implicit-discovery pipeline. The pi-embedded runner
  // only needs models.json to contain the one provider it's about to call.
  const targetProvider = options?.targetProvider?.trim();
  if (targetProvider) {
    const explicitProviders = cfg.models?.providers ?? {};
    const explicitHasTarget = Boolean(explicitProviders[targetProvider]);
    if (explicitHasTarget) {
      const onDiskHasTarget = await readExistingProviderIsConfigured(targetPath, targetProvider);
      if (onDiskHasTarget) {
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
  });
  const cached = MODELS_JSON_STATE.readyCache.get(targetPath);
  if (cached) {
    const settled = await cached;
    if (settled.fingerprint === fingerprint) {
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
  MODELS_JSON_STATE.readyCache.set(targetPath, pending);
  try {
    const settled = await pending;
    return settled.result;
  } catch (error) {
    if (MODELS_JSON_STATE.readyCache.get(targetPath) === pending) {
      MODELS_JSON_STATE.readyCache.delete(targetPath);
    }
    throw error;
  }
}
