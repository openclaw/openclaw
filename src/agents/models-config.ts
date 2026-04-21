import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  getRuntimeConfigSourceSnapshot,
  projectConfigOntoRuntimeSourceSnapshot,
  type OpenClawConfig,
  loadConfig,
} from "../config/config.js";
import { createConfigRuntimeEnv } from "../config/env-vars.js";
import { isRecord } from "../utils.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
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
  "token",
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
 * Compute a content-based fingerprint for a JSON file whose mtime may
 * change without meaningful content change (e.g. auth-profiles.json rewritten
 * by OAuth token refresh).
 *
 * Returns null if the file does not exist or cannot be parsed; returns the
 * file's raw SHA-256 hash as a fallback if JSON parsing fails but the file
 * exists.
 */
async function readAuthProfilesStableHash(pathname: string): Promise<string | null> {
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
  const stable = stripAuthProfilesVolatileFields(parsed);
  return createHash("sha256").update(stableStringify(stable)).digest("hex");
}

function stripAuthProfilesVolatileFields(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => stripAuthProfilesVolatileFields(entry));
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (AUTH_PROFILE_VOLATILE_FIELDS.has(key)) {
      continue;
    }
    result[key] = stripAuthProfilesVolatileFields(entry);
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
  return stableStringify({
    config: params.config,
    sourceConfigForSecrets: params.sourceConfigForSecrets,
    envShape,
    authProfilesHash,
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
    const loaded = loadConfig();
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
  options?: EnsureOpenClawModelsJsonOptions,
): Promise<{ agentDir: string; wrote: boolean }> {
  const resolved = resolveModelsConfigInput(config);
  const cfg = resolved.config;
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
      existingRaw: existingModelsFile.raw,
      existingParsed: existingModelsFile.parsed,
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
