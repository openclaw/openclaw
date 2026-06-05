/**
 * Ensures the agent-local models.json and plugin model catalog sidecars match
 * runtime config, discovered providers, auth-profile state, and generated
 * catalog ownership.
 */
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
import { MODELS_JSON_STATE, type ContentHashOutcome } from "./models-config-state.js";
import { planOpenClawModelsJson } from "./models-config.plan.js";
import {
  decodePluginModelCatalogRelativePathPluginId,
  isGeneratedPluginModelCatalog,
  isPluginModelCatalogRelativePath,
  listPluginModelCatalogRelativePaths,
  resolvePluginModelCatalogOwnerPluginId,
} from "./plugin-model-catalog.js";
import { stableStringify } from "./stable-stringify.js";

export { resetModelsJsonReadyCacheForTest } from "./models-config-state.js";

/**
 * Fields on an auth profile that rotate frequently without changing the
 * shape of what providers are available (OAuth token refreshes,
 * expirations).  We exclude them from the fingerprint so token rotation
 * does not invalidate the implicit-provider-discovery cache.
 *
 * NOTE: this base set applies to OAuth and other non-`type: "token"`
 * profiles.  For `type: "token"` profiles, `expires`/`expiresAt`/
 * `expiresIn` are credential ELIGIBILITY policy — `resolveApiKeyForProfile`
 * returns null when a token profile's `expires` is in the past or invalid.
 * If we strip those fields for token profiles, a transition from valid
 * to expired (without any other field change) leaves the fingerprint
 * unchanged and the ready cache hands back stale provider state. See
 * `getVolatileFieldsForProfileObject` below for the per-type selection.
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
 * Volatile fields applied to `type: "token"` profile objects.  Mirrors
 * the base set MINUS `expires`/`expiresAt`/`expiresIn`: those drive
 * eligibility for token credentials (an expired token profile resolves
 * to `null` in `resolveApiKeyForProfile`), so a fingerprint that strips
 * them would let valid->expired transitions ride a stale ready-cache
 * entry.  `access`/`refresh` and the `*At` session-management fields
 * remain volatile for all profile types.
 */
const AUTH_PROFILE_VOLATILE_FIELDS_TOKEN: ReadonlySet<string> = new Set([
  "access",
  "refresh",
  "issuedAt",
  "refreshedAt",
  "lastCheckedAt",
  "lastRefreshAt",
  "lastValidatedAt",
]);

/**
 * Pick the volatile-fields set to apply when stripping an object that
 * looks like a profile entry inside `auth-profiles.json`.  Profile
 * entries are reached at depth=2 by `stripAuthProfilesVolatileFields`
 * (root object -> `profiles` map -> profile value).  We detect the
 * type by inspecting `type === "token"` directly on the object so any
 * future profile types are covered by the OAuth/default branch.
 */
function getVolatileFieldsForProfileObject(value: Record<string, unknown>): ReadonlySet<string> {
  if (value.type === "token") {
    return AUTH_PROFILE_VOLATILE_FIELDS_TOKEN;
  }
  return AUTH_PROFILE_VOLATILE_FIELDS;
}

/**
 * Hard cap on the bytes we will read + parse from auth-profiles.json when
 * computing the stable fingerprint hash.  Without a cap, a crafted/large
 * profile file becomes a CPU + memory exhaustion vector via fs.readFile +
 * JSON.parse + recursive walk + stableStringify.  Above the cap,
 * `safeReadFileOutcome` returns `{ kind: "uncacheable" }` and
 * `ensureOpenClawModelsJson` bypasses the ready cache entirely (fail-closed)
 * — the file is never partially hashed and an oversize auth-profiles.json
 * cannot ride a stale cache entry. See the discriminated `ContentHashOutcome`
 * type and `modelsContentOutcomesMatch` for the cache-hit semantics.
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
 * Outcome of a bounded streaming read.  See `ContentHashOutcome` in
 * `models-config-state.ts` for the cache-side contract; this variant
 * additionally carries the raw bytes when the read succeeded so callers
 * (e.g. JSON parsers) can avoid re-reading the file.
 */
type FileReadOutcome =
  | { kind: "absent" }
  | { kind: "hashed"; hash: string; raw: Buffer }
  | { kind: "uncacheable" };

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
 *    return `{ kind: "uncacheable" }` (fail closed, CWE-345).  The
 *    previous size-only sentinel `oversize:${size}` let an attacker swap
 *    the contents of an oversized file without changing its byte length
 *    and still hit the cache; the round-3 follow-up collapsed that to
 *    `null`, which then merged with the legitimate "file absent" state
 *    (round-4 / Codex P1+P2): a `null === null` compare let unhashable
 *    files (oversize, symlink, I/O error) keep granting cache hits, AND
 *    let oversize auth-profiles edits keep hitting the readyCache as
 *    long as the file stayed oversize.
 *
 *    The discriminated-union outcome closes both: `uncacheable` is a
 *    distinct, sticky-miss state that does NOT compare equal to itself
 *    or to anything else.  Callers (cache-hit predicate, fingerprint
 *    builder) treat it as drift / cache bypass.
 *
 * The streaming reader is destroyed if accumulated bytes exceed maxBytes,
 * so an attacker cannot grow the file between lstat and read past the
 * cap.
 */
async function safeReadFileOutcome(pathname: string, maxBytes: number): Promise<FileReadOutcome> {
  // lstat + isFile() + isSymbolicLink() rejects symlinks and any
  // non-regular file (directory, socket, FIFO, device).  ENOENT is the
  // ONLY lstat error we treat as `absent`; every other error is
  // `uncacheable` so e.g. EACCES does not silently masquerade as a
  // legitimate "file does not exist" steady state.
  let lst: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    lst = await fs.lstat(pathname);
  } catch (e) {
    if ((e as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { kind: "absent" };
    }
    return { kind: "uncacheable" };
  }
  if (lst.isSymbolicLink() || !lst.isFile()) {
    return { kind: "uncacheable" };
  }
  if (lst.size > maxBytes) {
    // Oversize at lstat time — fail closed.  See the JSDoc above for
    // the threat model.  An attacker who keeps the file oversize gets
    // a sticky-miss; they cannot collide their content with the cached
    // entry by matching byte length.
    return { kind: "uncacheable" };
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
      return { kind: "uncacheable" };
    }
    const stream = createReadStream("", { fd: fh.fd, autoClose: false, highWaterMark: 64 * 1024 });
    const hash = createHash("sha256");
    let seen = 0;
    let truncated = false;
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Buffer) => {
        seen += chunk.length;
        if (seen > maxBytes) {
          // File grew past the cap mid-read.  Destroy and surface as
          // `uncacheable` — matching the lstat-time oversize check
          // above.
          truncated = true;
          stream.destroy(new Error("file grew past cap during read"));
          return;
        }
        hash.update(chunk);
        chunks.push(chunk);
      });
      stream.on("error", reject);
      stream.on("end", () => resolve());
    });
    if (truncated) {
      return { kind: "uncacheable" };
    }
    return { kind: "hashed", hash: hash.digest("hex"), raw: Buffer.concat(chunks) };
  } catch {
    return { kind: "uncacheable" };
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/**
 * Compute a content-based outcome for auth-profiles.json that is
 * stable across OAuth token rotations.  Returns:
 *  - `{ kind: "absent" }` when the file does not exist.
 *  - `{ kind: "hashed", hash }` for a successfully-read profile file.
 *    JSON parse failures fall back to the raw-content hash so structural
 *    changes still register, just without canonicalization.
 *  - `{ kind: "uncacheable" }` for symlinks, non-regular files,
 *    oversize, or any I/O error.  The caller MUST bypass the readyCache
 *    in this state — otherwise oversize same-size variants would all
 *    collapse to a single fingerprint contribution and let credential
 *    edits keep hitting a stale entry.  See `ensureOpenClawModelsJson`
 *    for the bypass logic and Codex P2 follow-up on PR #73260 for the
 *    threat model.
 */
async function readAuthProfilesStableOutcome(pathname: string): Promise<ContentHashOutcome> {
  const outcome = await safeReadFileOutcome(pathname, MAX_AUTH_PROFILES_BYTES);
  if (outcome.kind !== "hashed") {
    return outcome;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.raw.toString("utf8"));
  } catch {
    // File exists but is unparseable; the raw-content hash already
    // reflects this.  Return it as-is so structural changes register.
    return { kind: "hashed", hash: outcome.hash };
  }
  const stable = stripAuthProfilesVolatileFields(parsed, 0);
  const stableHash = createHash("sha256").update(stableStringify(stable)).digest("hex");
  return { kind: "hashed", hash: stableHash };
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
  const valueRecord = value as Record<string, unknown>;
  // Pick the volatile-field set based on the profile `type` so token
  // profiles preserve their `expires*` fields (which drive eligibility
  // in `resolveApiKeyForProfile`) while OAuth profiles strip them as
  // session-rotation noise.  Non-profile objects (root, profile map,
  // nested metadata) won't carry `type: "token"`, so they fall through
  // to the default OAuth/non-token volatile set, preserving prior
  // behavior outside profile entries.
  const volatileFields = getVolatileFieldsForProfileObject(valueRecord);
  // Build with Object.create(null) so prototype-mutating keys ("__proto__",
  // "constructor", "prototype") in untrusted input can't pollute the
  // resulting object's prototype chain.  Filter them explicitly too —
  // belt and suspenders (CWE-1321).
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, entry] of Object.entries(valueRecord)) {
    if (volatileFields.has(key)) {
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
 * input).  Instead we capture a content outcome AT WRITE TIME and
 * verify it on every cache hit via `modelsContentOutcomesMatch`.
 *
 * Returns:
 *  - `{ kind: "absent" }` when the file legitimately does not exist.
 *    Two consecutive absent reads (write-time and check-time) compare
 *    equal, which is a valid steady-state cache hit (file legitimately
 *    does not exist — `plan.action === "skip"` no-op case).
 *  - `{ kind: "hashed", hash }` for a successfully-read file.  Two
 *    `hashed` outcomes match iff their hashes are identical.
 *  - `{ kind: "uncacheable" }` for symlinks, non-regular files,
 *    oversize, or any I/O error.  This NEVER matches anything (Codex P1
 *    follow-up on PR #73260): an unhashable models.json — typically
 *    >1 MiB or replaced by a symlink mid-flight — must force re-plan
 *    instead of letting `null === null` grant a stale cache hit.  This
 *    is the fail-closed contract that mirrors the auth-profiles
 *    sticky-miss path.
 */
async function readModelsJsonContentOutcome(pathname: string): Promise<ContentHashOutcome> {
  const outcome = await safeReadFileOutcome(pathname, MAX_MODELS_JSON_BYTES);
  if (outcome.kind === "absent") {
    return { kind: "absent" };
  }
  if (outcome.kind === "hashed") {
    return { kind: "hashed", hash: outcome.hash };
  }
  return { kind: "uncacheable" };
}

/**
 * Cache-hit predicate for `modelsJsonOutcome`.  Implements the
 * fail-closed contract documented on `ContentHashOutcome`:
 *
 *  - `absent === absent` is a valid hit (stable absence).
 *  - `hashed === hashed` is a valid hit iff the hashes are identical.
 *  - `uncacheable` on EITHER side is always a miss.  Even an
 *    `uncacheable === uncacheable` compare must miss because both
 *    sides could correspond to different attacker-controlled content
 *    (e.g. two different >1 MiB models.json variants that trip the cap).
 *    The only safe response is to re-plan.
 */
function modelsContentOutcomesMatch(a: ContentHashOutcome, b: ContentHashOutcome): boolean {
  if (a.kind === "uncacheable" || b.kind === "uncacheable") {
    return false;
  }
  if (a.kind === "absent" && b.kind === "absent") {
    return true;
  }
  if (a.kind === "hashed" && b.kind === "hashed") {
    return a.hash === b.hash;
  }
  return false;
}

function buildModelsJsonFingerprint(params: {
  config: OpenClawConfig;
  sourceConfigForSecrets: OpenClawConfig;
  agentDir: string;
  authProfilesOutcome: ContentHashOutcome;
  workspaceDir?: string;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index">;
  providerDiscoveryProviderIds?: readonly string[];
  providerDiscoveryTimeoutMs?: number;
  providerDiscoveryEntriesOnly?: boolean;
}): string {
  // Use a content-based hash for auth-profiles instead of mtime so OAuth
  // token rotation doesn't invalidate the cache.  models.json drift is
  // tracked separately via modelsJsonOutcome on the readyCache entry (the
  // file is the output of this function, not an input — including its
  // state in the fingerprint would cause every run to invalidate its
  // own cache).
  //
  // Auth-profiles outcome MUST be `absent` or `hashed` here (the caller
  // bypasses the readyCache entirely when the outcome is `uncacheable`,
  // so we never compute a fingerprint that includes an oversize file).
  // We assert the invariant defensively to prevent a future caller from
  // accidentally feeding `uncacheable` in and producing a fingerprint
  // that collides across all oversize variants (Codex P2 follow-up on
  // PR #73260).
  const { authProfilesOutcome } = params;
  if (authProfilesOutcome.kind === "uncacheable") {
    throw new Error(
      "buildModelsJsonFingerprint: refusing to fingerprint with an uncacheable auth-profiles outcome",
    );
  }
  const authProfilesHash = authProfilesOutcome.kind === "hashed" ? authProfilesOutcome.hash : null;
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

/** Best-effort chmod for generated models.json and plugin catalog files. */
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

/** Atomic private-file-store write used by models.json generation. */
export async function writeModelsFileAtomicForModelsJson(
  targetPath: string,
  contents: string,
): Promise<void> {
  await privateFileStore(path.dirname(targetPath)).writeText(path.basename(targetPath), contents);
}

async function isGeneratedPluginCatalogFile(targetPath: string): Promise<boolean> {
  return (await readGeneratedPluginCatalog(targetPath)) !== undefined;
}

async function readGeneratedPluginCatalog(targetPath: string): Promise<unknown> {
  const existing = await readExistingModelsFile(targetPath);
  const parsed = existing.parsed;
  return isGeneratedPluginModelCatalog(parsed) ? parsed : undefined;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function mergeGeneratedPluginCatalogProvidersIntoExistingParsed(params: {
  agentDir: string;
  existingParsed: unknown;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "owners">;
}): Promise<unknown> {
  const root = isRecordLike(params.existingParsed) ? params.existingParsed : {};
  const providers = isRecordLike(root.providers) ? { ...root.providers } : {};
  let changed = false;
  for (const relativePath of listPluginModelCatalogRelativePaths(params.agentDir)) {
    const catalogPluginId = decodePluginModelCatalogRelativePathPluginId(relativePath);
    if (!catalogPluginId) {
      continue;
    }
    const catalog = await readGeneratedPluginCatalog(path.join(params.agentDir, relativePath));
    if (!isRecordLike(catalog) || !isRecordLike(catalog.providers)) {
      continue;
    }
    for (const [providerId, provider] of Object.entries(catalog.providers)) {
      const currentOwnerPluginId = resolvePluginModelCatalogOwnerPluginId({
        providerId,
        pluginMetadataSnapshot: params.pluginMetadataSnapshot,
      });
      if (currentOwnerPluginId !== catalogPluginId) {
        continue;
      }
      providers[providerId] = provider;
      changed = true;
    }
  }
  if (!changed) {
    return params.existingParsed;
  }
  return { ...root, providers };
}

async function removeStalePluginCatalogs(params: {
  agentDir: string;
  activeRelativePaths: ReadonlySet<string>;
}): Promise<boolean> {
  let wrote = false;
  for (const relativePath of listPluginModelCatalogRelativePaths(params.agentDir)) {
    if (params.activeRelativePaths.has(path.normalize(relativePath))) {
      continue;
    }
    const targetPath = path.join(params.agentDir, relativePath);
    if (!(await isGeneratedPluginCatalogFile(targetPath))) {
      continue;
    }
    await fs.unlink(targetPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    });
    wrote = true;
  }
  return wrote;
}

async function writePluginCatalogsForModelsJson(params: {
  agentDir: string;
  pluginCatalogWrites?: Record<string, string>;
}): Promise<boolean> {
  if (!params.pluginCatalogWrites) {
    return false;
  }
  let wrote = false;
  const activeRelativePaths = new Set<string>();
  for (const [relativePath, contents] of Object.entries(params.pluginCatalogWrites)) {
    if (!isPluginModelCatalogRelativePath(relativePath)) {
      continue;
    }
    activeRelativePaths.add(path.normalize(relativePath));
    const targetPath = path.join(params.agentDir, relativePath);
    const existing = await readExistingModelsFile(targetPath);
    if (existing.raw === contents) {
      await ensureModelsFileModeForModelsJson(targetPath);
      continue;
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    await writeModelsFileAtomicForModelsJson(targetPath, contents);
    await ensureModelsFileModeForModelsJson(targetPath);
    wrote = true;
  }
  const removedStale = await removeStalePluginCatalogs({
    agentDir: params.agentDir,
    activeRelativePaths,
  });
  return wrote || removedStale;
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

/** Ensures models.json and plugin catalog sidecars are current for an agent. */
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
  const providerScopedDiscovery = Boolean(options.providerDiscoveryProviderIds?.length);
  const pluginMetadataSnapshot =
    options.pluginMetadataSnapshot ??
    resolvePluginMetadataSnapshot({
      config: cfg,
      env: createConfigRuntimeEnv(cfg),
      ...(workspaceDir ? { workspaceDir } : {}),
      ...(providerScopedDiscovery ? { preferPersisted: false } : {}),
    });
  const agentDir = agentDirOverride?.trim() ? agentDirOverride.trim() : resolveDefaultAgentDir(cfg);
  const targetPath = path.join(agentDir, "models.json");
  // Read auth-profiles.json BEFORE deciding whether to read or write to
  // the readyCache.  When the file is `uncacheable` (oversize, symlink,
  // I/O error) we must bypass the cache entirely — otherwise all
  // oversize variants would collapse to a single fingerprint contribution
  // and a credential edit that keeps the file oversize would keep hitting
  // a stale entry (Codex P2 follow-up on PR #73260).  Bypassing the cache
  // also avoids writing dead entries that an attacker who keeps the file
  // oversize could never evict.
  const authProfilesPath = path.join(agentDir, "auth-profiles.json");
  const authProfilesOutcome = await readAuthProfilesStableOutcome(authProfilesPath);
  const cacheable = authProfilesOutcome.kind !== "uncacheable";

  const planAndWrite = (
    fingerprintForEntry: string,
  ): Promise<{
    fingerprint: string;
    modelsJsonOutcome: ContentHashOutcome;
    result: { agentDir: string; wrote: boolean };
  }> =>
    withModelsJsonWriteLock(targetPath, async () => {
      // Ensure config env vars (e.g. AWS_PROFILE, AWS_ACCESS_KEY_ID) are
      // are available to provider discovery without mutating process.env.
      const env = createConfigRuntimeEnv(cfg);
      const existingModelsFile = await readExistingModelsFile(targetPath);
      const existingParsedForMerge = await mergeGeneratedPluginCatalogProvidersIntoExistingParsed({
        agentDir,
        existingParsed: existingModelsFile.parsed,
        ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
      });
      const plan = await planOpenClawModelsJson({
        cfg,
        sourceConfigForSecrets: resolved.sourceConfigForSecrets,
        agentDir,
        env,
        ...(workspaceDir ? { workspaceDir } : {}),
        existingRaw: existingModelsFile.raw,
        existingParsed: existingParsedForMerge,
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
        const wrotePluginCatalog = await writePluginCatalogsForModelsJson({
          agentDir,
          pluginCatalogWrites: plan.pluginCatalogWrites,
        });
        const modelsJsonOutcome = await readModelsJsonContentOutcome(targetPath);
        return {
          fingerprint: fingerprintForEntry,
          modelsJsonOutcome,
          result: { agentDir, wrote: wrotePluginCatalog },
        };
      }

      if (plan.action === "noop") {
        const wrotePluginCatalog = await writePluginCatalogsForModelsJson({
          agentDir,
          pluginCatalogWrites: plan.pluginCatalogWrites,
        });
        await ensureModelsFileModeForModelsJson(targetPath);
        const modelsJsonOutcome = await readModelsJsonContentOutcome(targetPath);
        return {
          fingerprint: fingerprintForEntry,
          modelsJsonOutcome,
          result: { agentDir, wrote: wrotePluginCatalog },
        };
      }

      await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
      await writeModelsFileAtomicForModelsJson(targetPath, plan.contents);
      await ensureModelsFileModeForModelsJson(targetPath);
      await writePluginCatalogsForModelsJson({
        agentDir,
        pluginCatalogWrites: plan.pluginCatalogWrites,
      });
      // Capture the post-write outcome so subsequent cache checks can
      // detect any external edit / corruption that happens after this
      // point.
      const modelsJsonOutcome = await readModelsJsonContentOutcome(targetPath);
      return {
        fingerprint: fingerprintForEntry,
        modelsJsonOutcome,
        result: { agentDir, wrote: true },
      };
    });

  if (!cacheable) {
    // Cache-bypass mode: auth-profiles is `uncacheable`, so we re-plan
    // unconditionally and never touch the readyCache.  The sentinel
    // fingerprint passed below is informational only — we deliberately
    // do not READ from or WRITE to the readyCache in this mode, so the
    // entry never lands in the global map and cannot collide with a
    // legitimate cached entry.
    const sentinelFingerprint = `uncacheable:${createHash("sha256")
      .update(`${process.pid}\0${Date.now()}\0${Math.random()}\0${targetPath}`)
      .digest("hex")}`;
    return (await planAndWrite(sentinelFingerprint)).result;
  }

  const fingerprint = buildModelsJsonFingerprint({
    config: cfg,
    sourceConfigForSecrets: resolved.sourceConfigForSecrets,
    agentDir,
    authProfilesOutcome,
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
    // Two-factor cache hit: the cache key already includes the
    // fingerprint (so different fingerprints get different entries),
    // but we ALSO verify that the on-disk models.json outcome still
    // matches what we captured at write time via
    // `modelsContentOutcomesMatch` — a fail-closed predicate that
    // treats `uncacheable` outcomes as never-equal so unhashable files
    // (oversize, symlink, I/O error) force re-plan instead of riding a
    // `null === null` compare to a stale hit (Codex P1 follow-up on
    // PR #73260).
    const currentModelsJsonOutcome = await readModelsJsonContentOutcome(targetPath);
    if (modelsContentOutcomesMatch(currentModelsJsonOutcome, settled.modelsJsonOutcome)) {
      await ensureModelsFileModeForModelsJson(targetPath);
      return settled.result;
    }
  }

  const pending = planAndWrite(fingerprint);
  MODELS_JSON_STATE.readyCache.set(cacheKey, pending);
  try {
    const settled = await pending;
    // Re-read auth-profiles after the write to pick up any plan-driven
    // mutation.  If the post-write outcome is uncacheable, drop the cache
    // entry instead of carrying it forward — the next call would bypass
    // anyway, but evicting now keeps the readyCache from accumulating
    // dead entries.
    const refreshedAuthOutcome = await readAuthProfilesStableOutcome(authProfilesPath);
    if (refreshedAuthOutcome.kind === "uncacheable") {
      if (MODELS_JSON_STATE.readyCache.get(cacheKey) === pending) {
        MODELS_JSON_STATE.readyCache.delete(cacheKey);
      }
      return settled.result;
    }
    const refreshedFingerprint = buildModelsJsonFingerprint({
      config: cfg,
      sourceConfigForSecrets: resolved.sourceConfigForSecrets,
      agentDir,
      authProfilesOutcome: refreshedAuthOutcome,
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
          modelsJsonOutcome: settled.modelsJsonOutcome,
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
