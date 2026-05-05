import { createHash } from "node:crypto";
import { constants as FS_CONSTANTS, createReadStream } from "node:fs";
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
 * Hard cap on the bytes we will read + hash from models.json (Aisle
 * medium #2 on PR #73260).  Realistic models.json sizes are dominated
 * by listed models per provider; ~1 MiB is plenty of headroom while
 * bounding the worst-case allocation.
 */
const MAX_MODELS_JSON_BYTES = 1 * 1024 * 1024;

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
 * Stream-hash a regular file with bounded memory.  Closes a family of
 * issues raised on PR #73260:
 *  - Codex P1 "Enforce size limit when hashing oversized auth-profiles":
 *    the previous oversize-branch did fs.readFile(path) which pulled the
 *    entire file into memory regardless of MAX_AUTH_PROFILES_BYTES.
 *  - Aisle medium #2 (CWE-400 unbounded read): same problem on
 *    models.json hashing.
 *  - Aisle medium #3 (CWE-59 symlink-following reads): rejects symlinks
 *    and non-regular files via lstat before opening.  Uses O_NOFOLLOW
 *    where supported so a symlink swap-in between lstat and open also
 *    fails closed.
 *  - Aisle medium / Codex P2 followup on #73260: oversized files now
 *    return null (fail closed, CWE-345).  The previous size-only
 *    sentinel `oversize:${size}` let an attacker swap the contents of
 *    an oversized file without changing its byte length and still hit
 *    the cache; returning null forces the caller's re-plan path so the
 *    cache cannot be evaded by a same-size content swap.  This is
 *    consistent with the "return null forces re-plan" contract used
 *    everywhere else in this helper.
 *
 * The streaming reader is destroyed if accumulated bytes exceed maxBytes,
 * so an attacker cannot grow the file between lstat and read past the
 * cap.
 */
async function safeHashRegularFile(
  pathname: string,
  maxBytes: number,
): Promise<{ hash: string; raw: Buffer } | null> {
  // lstat + isFile() + isSymbolicLink() rejects symlinks and any
  // non-regular file (directory, socket, FIFO, device).
  const lst = await fs.lstat(pathname).catch(() => null);
  if (!lst || lst.isSymbolicLink() || !lst.isFile()) {
    return null;
  }
  if (lst.size > maxBytes) {
    // Oversize at lstat time — fail closed.  Returning null forces the
    // caller to treat this file as unhashable, so the readyCache cannot
    // grant a cache hit based on a size-derived sentinel that ignores
    // content.  See the JSDoc above for the threat model.
    return null;
  }
  // Open with O_NOFOLLOW (where the platform supports it) to close a
  // narrow TOCTOU window between lstat and open: if a symlink is
  // swapped in after lstat succeeds, the open will fail (ELOOP) instead
  // of following the link.
  const flags =
    typeof FS_CONSTANTS.O_NOFOLLOW === "number"
      ? FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW
      : FS_CONSTANTS.O_RDONLY;
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    fh = await fs.open(pathname, flags);
    // fstat after open: if the open raced past a symlink swap (only
    // possible on platforms without O_NOFOLLOW), the fd should still
    // refer to a regular file.
    const fst = await fh.stat();
    if (!fst.isFile() || fst.size > maxBytes) {
      return null;
    }
    const stream = createReadStream("", { fd: fh.fd, autoClose: false, highWaterMark: 64 * 1024 });
    const hash = createHash("sha256");
    let seen = 0;
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Buffer) => {
        seen += chunk.length;
        if (seen > maxBytes) {
          // File grew past the cap mid-read.  Destroy with an error so
          // the surrounding try/catch returns null (fail closed) —
          // matching the lstat-time oversize check above.
          stream.destroy(new Error("file grew past cap during read"));
          return;
        }
        hash.update(chunk);
        chunks.push(chunk);
      });
      stream.on("error", reject);
      stream.on("end", () => resolve());
    });
    return { hash: hash.digest("hex"), raw: Buffer.concat(chunks) };
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/**
 * Compute a content-based fingerprint for auth-profiles.json that is
 * stable across OAuth token rotations.  Returns null if the file does
 * not exist or fails the safe-read checks (symlink, non-regular,
 * oversize, or any I/O error).  Oversize files fail closed (return
 * null) rather than producing a size-derived sentinel — see the
 * `safeHashRegularFile` JSDoc for the threat model.  Falls back to a
 * raw-content hash if JSON parsing fails (so structural changes still
 * register, just without canonicalization).
 */
async function readAuthProfilesStableHash(pathname: string): Promise<string | null> {
  const safe = await safeHashRegularFile(pathname, MAX_AUTH_PROFILES_BYTES);
  if (!safe) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(safe.raw.toString("utf8"));
  } catch {
    // File exists but is unparseable; the raw-content hash already
    // reflects this.  Return it as-is so structural changes register.
    return safe.hash;
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
 * Hash the contents of models.json so external edits / partial
 * corruption / manual tampering invalidate the readyCache.  The
 * fingerprint alone cannot catch external edits because it does not
 * include models.json state (its contents are the OUTPUT, not an
 * input).  Instead we capture a content hash AT WRITE TIME and verify
 * it on every cache hit.
 *
 * Returns null when the file is absent OR fails the safe-read checks
 * (symlink, non-regular, oversize, or any I/O error).  Two consecutive
 * absent reads (write-time and check-time) compare equal as `null ===
 * null`, which is a valid steady-state cache hit (file legitimately
 * does not exist).  Any disagreement — including a captured non-null
 * hash followed by a null read, or a string hash followed by a different
 * string — forces re-plan.  This is the intended skip-and-noop
 * semantics: stable absence means stable result, drift means re-plan.
 * (Greptile P2 on PR #73260 noted the previous JSDoc was the opposite
 * of this behaviour.)
 */
async function readModelsJsonContentHash(pathname: string): Promise<string | null> {
  const safe = await safeHashRegularFile(pathname, MAX_MODELS_JSON_BYTES);
  return safe ? safe.hash : null;
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
  providerDiscoveryEntriesOnly?: boolean;
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
    providerDiscoveryEntriesOnly: params.providerDiscoveryEntriesOnly === true,
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
  // CWE-59 + CWE-367 hardening (Aisle high #1 on #72869 + Aisle medium
  // #1 on #73260):  the previous lstat-then-chmod sequence was racy —
  // an attacker who could rename/replace ${agentDir}/models.json
  // between lstat() and chmod() could win the race and have chmod()
  // follow a swapped-in symlink to an arbitrary file owned by the
  // gateway user.
  //
  // Instead, open the file with O_NOFOLLOW (where supported) so the
  // open itself refuses symlinks atomically, then fchmod() through the
  // resulting file descriptor.  This collapses the check-and-act into a
  // single kernel-mediated operation, eliminating the race.
  const flags =
    typeof FS_CONSTANTS.O_NOFOLLOW === "number"
      ? FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW
      : FS_CONSTANTS.O_RDONLY;
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    fh = await fs.open(pathname, flags);
    const fst = await fh.stat();
    if (!fst.isFile()) {
      return;
    }
    await fh.chmod(0o600);
  } catch {
    // best-effort — file may not exist yet, may be a symlink (open
    // fails with ELOOP under O_NOFOLLOW), or may have been deleted
    // between checks.  Any of these are acceptable no-ops.
  } finally {
    await fh?.close().catch(() => undefined);
  }
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
  providerDiscoveryEntriesOnly?: boolean;
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
    ...(options.providerDiscoveryEntriesOnly === true
      ? { providerDiscoveryEntriesOnly: true }
      : {}),
  });
  const cacheKey = modelsJsonReadyCacheKey(targetPath, fingerprint);
  const cached = MODELS_JSON_STATE.readyCache.get(cacheKey);
  if (cached) {
    // Warm in-memory cache hit: same inputs, already-planned result.
    // This is the fastest path — no disk I/O at all.
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
      ...(options.providerDiscoveryEntriesOnly === true
        ? { providerDiscoveryEntriesOnly: true }
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
      ...(options.providerDiscoveryEntriesOnly === true
        ? { providerDiscoveryEntriesOnly: true }
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
