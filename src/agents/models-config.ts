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
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { privateFileStore } from "../infra/private-file-store.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "../plugins/manifest-registry-installed.js";
import {
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";
import { isRecord } from "../utils.js";
import {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentDir,
  resolveDefaultAgentId,
} from "./agent-scope.js";
import { readPersistedAuthProfileStoreRaw } from "./auth-profiles/sqlite.js";
import { MODELS_JSON_STATE, type ContentHashOutcome } from "./models-config-state.js";
import { planOpenClawModelsJson } from "./models-config.plan.js";
import { normalizeProviderSpecificConfig } from "./models-config.providers.policy.js";
import {
  normalizeHeaderValues,
  resolveAwsSdkApiKeyVarName,
  resolveEnvApiKeyVarName,
  type SecretDefaults,
} from "./models-config.providers.secret-helpers.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";
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
 * does not invalidate the implicit-provider-discovery cache.  This is the
 * default (OAuth / non-token) set; `type: "token"` profiles use the
 * narrower `AUTH_PROFILE_VOLATILE_FIELDS_TOKEN` set below.  See
 * `getVolatileFieldsForProfileObject` for the per-type selection.
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
 * looks like a profile entry inside the auth-profile store.  Profile
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
 * Sanity bound on the serialized auth-profile store payload we will hash
 * for the fingerprint.  A multi-MiB store is not a realistic production
 * state; above the cap `readAuthProfilesStableOutcome` fails closed
 * (`uncacheable`) instead of spending CPU on the strip + stableStringify +
 * sha256 of a pathological payload.
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
 * Compute a content-based outcome for the agent's auth-profile secrets
 * store that is stable across OAuth token rotations.  Reads the CANONICAL
 * SQLite store (`openclaw-agent.sqlite`, the `auth_profile_store` row) via
 * the warm pooled agent DB handle — NOT the legacy `auth-profiles.json`
 * file, which is migration-only debt per the storage policy ("SQLite
 * only").  Hashing the legacy JSON file silently read `absent` for every
 * agent already migrated to SQLite, so real credential changes never
 * invalidated the implicit-provider-discovery cache.  Returns:
 *  - `{ kind: "absent" }` when no persisted store row exists (no auth
 *    profiles configured).  Stable absence is a valid steady-state hit.
 *  - `{ kind: "hashed", hash }` for a present store, hashed AFTER stripping
 *    per-type volatile session fields (`getVolatileFieldsForProfileObject`)
 *    so OAuth token rotation does not bust the cache while structural /
 *    static-credential / token-expiry changes still do.
 *  - `{ kind: "uncacheable" }` on a DB read failure, or a store whose
 *    stripped serialization exceeds MAX_AUTH_PROFILES_BYTES.  The caller
 *    MUST bypass the readyCache in this state (fail closed) so a transient
 *    read error or pathological payload cannot grant a stale cache hit.
 */
function readAuthProfilesStableOutcome(agentDir: string): ContentHashOutcome {
  let parsed: unknown;
  try {
    // Use the read-only, no-create path: call without an explicit DB handle so
    // `readPersistedAuthProfileStoreRaw` checks `fs.existsSync` first (returning
    // `null` for an absent store) and otherwise opens the SQLite file with
    // `{ readOnly: true }`.  Passing `openAuthProfileDatabase(agentDir)` here
    // would route through `openOpenClawAgentDatabase`, which `mkdirSync`s the
    // agent dir, creates the schema, and registers the database in the shared
    // pool — turning a fingerprint-only cache-key read into a write-side effect
    // that materializes agent SQLite state for no-auth / skip / noop calls
    // (Codex P2 on PR #90741, models-config.ts:295).
    parsed = readPersistedAuthProfileStoreRaw(agentDir);
  } catch {
    // DB open/read failure — fail closed rather than masquerade as absent.
    return { kind: "uncacheable" };
  }
  if (parsed === null || parsed === undefined) {
    return { kind: "absent" };
  }
  const stable = stripAuthProfilesVolatileFields(parsed, 0);
  const serialized = stableStringify(stable);
  if (Buffer.byteLength(serialized, "utf8") > MAX_AUTH_PROFILES_BYTES) {
    // Sanity bound on the hash input; a multi-MiB store payload is not a
    // realistic production state, so fail closed instead of hashing it.
    return { kind: "uncacheable" };
  }
  const stableHash = createHash("sha256").update(serialized).digest("hex");
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
 * Content outcome for the generated plugin model catalog sidecars that
 * `ensureOpenClawModelsJson` owns (`plugins/<plugin>/catalog.json`, written by
 * `writePluginCatalogsForModelsJson`).  Captured at write/validation time and
 * re-checked on every warm cache hit alongside `modelsJsonOutcome`.
 *
 * Why this exists (Codex P1 on PR #90741, models-config.ts:1501-1504): current
 * `main` folded generated plugin catalog sidecar mtimes into
 * `buildModelsJsonFingerprint`, so any sidecar edit/deletion busted the ready
 * cache.  This branch moved drift detection to a content outcome on the cache
 * entry, but only captured root `models.json` — leaving plugin catalog
 * sidecars unvalidated.  Because `planOpenClawModelsJson` owns those sidecars
 * (`pluginCatalogWrites`) and `ModelRegistry.loadCustomModels` consumes them
 * during provider/model resolution, a sidecar deleted or tampered AFTER a warm
 * entry was cached would still hit the cache and skip the reconciliation that
 * should rewrite/remove it — a provider-routing integrity hole.
 *
 * This is strictly stronger than `main`'s mtime fingerprint: it hashes the
 * sidecar CONTENTS (catching tampering that preserves mtime) and folds the
 * sorted set of sidecar relative paths into the digest (catching additions and
 * deletions), all under the same fail-closed `ContentHashOutcome` contract.
 *
 * Returns:
 *  - `{ kind: "absent" }` when no generated plugin catalog sidecars exist.
 *    Two `absent` reads compare equal — a valid steady-state hit.
 *  - `{ kind: "hashed", hash }` deterministically derived from the sorted
 *    `(relativePath, per-file content hash)` pairs.
 *  - `{ kind: "uncacheable" }` if ANY sidecar is unhashable (oversize,
 *    symlink, non-regular, I/O error).  Per the `modelsContentOutcomesMatch`
 *    contract, an `uncacheable` outcome never compares equal, so a single
 *    bad sidecar fails the whole cache hit closed and forces a re-plan.
 */
async function readPluginCatalogsContentOutcome(agentDir: string): Promise<ContentHashOutcome> {
  const relativePaths = listPluginModelCatalogRelativePaths(agentDir).toSorted((left, right) =>
    left.localeCompare(right),
  );
  const entries: Array<[string, string]> = [];
  for (const relativePath of relativePaths) {
    const outcome = await safeReadFileOutcome(
      path.join(agentDir, relativePath),
      MAX_MODELS_JSON_BYTES,
    );
    if (outcome.kind === "absent") {
      // The path lister enumerates on-disk catalog files, so an `absent`
      // read here means the file was removed between listing and reading.
      // Skip it — its absence is reflected by its exclusion from the
      // digest's path set, which differs from any entry that included it.
      continue;
    }
    if (outcome.kind === "uncacheable") {
      // Fail closed: a single unhashable sidecar poisons the whole outcome
      // so the cache hit can never ride a partial read to a stale entry.
      return { kind: "uncacheable" };
    }
    entries.push([path.normalize(relativePath), outcome.hash]);
  }
  if (entries.length === 0) {
    return { kind: "absent" };
  }
  // Sort again on the normalized paths so the digest is independent of
  // enumeration order, then hash the canonical (path, content-hash) pairs.
  entries.sort(([left], [right]) => left.localeCompare(right));
  const canonical = stableStringify(entries);
  return { kind: "hashed", hash: createHash("sha256").update(canonical).digest("hex") };
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
  /**
   * Model id the caller intends to use.  When provided alongside
   * `targetProvider`, the implicit-only short-circuit branch (where
   * `models.providers[targetProvider].models` is empty/omitted)
   * additionally requires this model id to appear on disk before
   * blessing the fast path (Codex P2 round-9 on PR #73261).  Without
   * this hint, implicit-discovery setups with stale `models.json`
   * could short-circuit and then fail in `resolveModelAsync` with
   * `Unknown model`.  Omit when the caller doesn't yet know which
   * model it will resolve; the prior provider-shape-only contract
   * still applies in that case.
   */
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
 * When `configuredProvider.apiKey` is unset, decide whether a non-empty
 * disk apiKey value matches what `planOpenClawModelsJson` would persist
 * via `resolveMissingProviderApiKey` (Codex P2 round-6 on PR #73261).
 *
 * The planner's "missing apiKey" path writes one of:
 *  1. The env-var name itself (e.g. `"OPENAI_API_KEY"`) when an env-
 *     derived marker is appropriate — the dominant case.  Disk holds
 *     the env var name, and we accept it iff the env var is currently
 *     populated (matches the same liveness check
 *     `resolveConfiguredApiKeyForCompare` applies for env-source
 *     refs).
 *  2. The AWS SDK env-var name (auth: "aws-sdk" branch) for AWS
 *     credential chains.  Same liveness check.
 *  3. The literal resolved value from a plaintext profile or a
 *     non-default `providerApiKeyResolver`.  We can't verify those
 *     here without re-running the planner, so this helper conservatively
 *     returns false for them — the perf cost is bounded (one full
 *     plan per restart that produces an unchanged disk shape).  When
 *     we add profile/state into the short-circuit context we should
 *     extend this helper symmetrically.
 *
 * Returns true iff the disk value matches case (1) or (2).  Returns
 * false otherwise (caller falls through to full planning).
 */
function diskApiKeyMatchesUnsetConfigPlannerOutput(params: {
  diskApiKey: unknown;
  providerKey: string;
  providerAuth: unknown;
  env: NodeJS.ProcessEnv;
}): boolean {
  const { diskApiKey, providerKey, providerAuth, env } = params;
  if (typeof diskApiKey !== "string" || diskApiKey.length === 0) {
    return false;
  }
  // Match `resolveMissingProviderApiKey`'s decision tree.  The aws-sdk
  // branch fires when `auth === "aws-sdk"`, otherwise the env-name
  // branch is consulted.  We do not invoke any provider-specific
  // `providerApiKeyResolver` here because the resolver may have
  // arbitrary side-effects in tests, and its env-name marker is
  // already covered by the env path below for any resolver that
  // returns an env var name.
  if (providerAuth === "aws-sdk") {
    const awsEnvVar = resolveAwsSdkApiKeyVarName(env);
    if (awsEnvVar && awsEnvVar === diskApiKey) {
      const value = env[awsEnvVar];
      return typeof value === "string" && value.length > 0;
    }
    return false;
  }
  const envVarName = resolveEnvApiKeyVarName(providerKey, env);
  if (envVarName && envVarName === diskApiKey) {
    const value = env[envVarName];
    return typeof value === "string" && value.length > 0;
  }
  return false;
}

/**
 * Maximum recursion depth when comparing disk-controlled values during
 * the short-circuit check (Codex P2 / Aisle medium #3 on PR #73261).
 * Bounds the recursive walk so a deeply-nested adversarial models.json
 * cannot stack-overflow or monopolize CPU during fingerprint compare.
 * 64 is well above any realistic models.json structure (~3 levels deep)
 * but small enough to bound the worst-case allocation.
 */
const SHORT_CIRCUIT_COMPARE_MAX_DEPTH = 64;

/**
 * Depth-bounded variant of stableStringify used for short-circuit
 * comparisons against disk-controlled state.  Throws when the depth
 * limit is exceeded — `stableEqualBounded` catches and treats that as
 * a non-match (fail closed → full plan).
 */
function stableStringifyBounded(value: unknown, maxDepth: number, depth = 0): string {
  if (depth > maxDepth) {
    throw new Error("stableStringifyBounded: max depth exceeded");
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((entry) => stableStringifyBounded(entry, maxDepth, depth + 1))
      .join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries
    .map(
      ([key, entry]) =>
        `${JSON.stringify(key)}:${stableStringifyBounded(entry, maxDepth, depth + 1)}`,
    )
    .join(",")}}`;
}

/**
 * Bounded structural equality.  Returns false on any depth-cap overrun
 * so adversarial nested input cannot DoS the gateway via stack/CPU
 * exhaustion during the short-circuit check.
 */
function stableEqualBounded(a: unknown, b: unknown, maxDepth: number): boolean {
  try {
    return stableStringifyBounded(a, maxDepth) === stableStringifyBounded(b, maxDepth);
  } catch {
    return false;
  }
}

/**
 * Per-model fields that can steer runtime transport (SSRF, header /
 * credential injection) when consumed from models.json — see the
 * runtime sinks at `src/agents/pi-embedded-runner/model.ts` which
 * fall back to `discoveredModel.baseUrl` / `discoveredModel.api` /
 * `discoveredModel.headers` when no provider-level override is set.
 *
 * The provider-scoped short-circuit cannot validate these without re-
 * running the planner, so it refuses to short-circuit when the on-disk
 * provider row carries any of them (Codex P1 / Aisle High #2 on PR
 * #73261).  The full plan re-applies provider/plugin defaults and
 * rewrites the file.
 */
const PER_MODEL_TRANSPORT_FIELDS: ReadonlySet<string> = new Set(["baseUrl", "api", "headers"]);

/**
 * Verify that the on-disk models.json provider entry STRUCTURALLY
 * matches what the current configuration would produce.  Used by the
 * short-circuit fast path to skip the implicit-provider-discovery
 * pipeline only when the disk state is provably consistent with config.
 *
 * Compares (all symmetric — either side undefined != string is a
 * mismatch, all bounded — adversarial depth fails closed):
 *   apiKey  — resolved through env-ref expansion before comparing
 *             (env-source values compare by env-var NAME, not value,
 *             since that's what plan writes to disk).  Fails closed on
 *             any non-string disk value when config has no apiKey
 *             (Codex P2 on PR #73261).
 *   baseUrl — bounded structural equality (closes asymmetric-undef bug)
 *   headers — bounded structural equality
 *   auth    — bounded structural equality
 *   models[] per-entry transport fields (`baseUrl`/`api`/`headers`) —
 *             refuses short-circuit if any disk-side model carries any
 *             of them (Codex P1 / Aisle High #2 on PR #73261).  The
 *             runtime consumes per-model transport when no provider-
 *             level override is set, so an attacker who can write
 *             models.json could otherwise inject per-model SSRF /
 *             credential-exfil routes that survive the provider-scoped
 *             check.  Refusing forces the planner to re-apply provider
 *             defaults and rewrite the file.
 *
 * Other model-level fields (id/name/cost/contextWindow/compat/...) are
 * not compared.  Tampering with those changes inference behaviour but
 * is not a transport-level exfil vector; the trade-off keeps the
 * short-circuit reachable for the common case where the planner persists
 * configured + discovered metadata without per-model transport overrides.
 *
 * Any mismatch (or any state we cannot conclusively verify, like a
 * non-env secret ref or a disk-side per-model transport override)
 * returns false so the caller falls through to the full plan + write
 * path.
 */
async function readExistingProviderMatchesConfig(
  targetPath: string,
  targetProvider: string,
  configuredProviderRaw: unknown,
  env: NodeJS.ProcessEnv,
  secretDefaults: SecretDefaults | undefined,
  targetModelId: string | undefined,
): Promise<{ matches: true; validatedModelsJsonOutcome: ContentHashOutcome } | { matches: false }> {
  if (!isRecord(configuredProviderRaw)) {
    return { matches: false };
  }
  // Reject prototype-chain key collisions for targetProvider (Aisle
  // medium #3 on PR #73261).  String keys like "__proto__" /
  // "constructor" / "prototype" should not steer the short-circuit.
  if (
    targetProvider === "__proto__" ||
    targetProvider === "constructor" ||
    targetProvider === "prototype"
  ) {
    return { matches: false };
  }
  // Apply the same provider-policy normalization that
  // `normalizeProviders` runs before `planOpenClawModelsJson` writes
  // the file (Codex P2 round-9 on PR #73261, models-config.ts:1282).
  // Some providers inject defaults at normalization time (e.g.
  // `extensions/ollama/provider-policy-api.ts` defaults `baseUrl` to
  // the local Ollama host when config omits it).  Without this
  // pre-pass, the structural compare runs config-as-authored vs
  // disk-as-normalized, so any provider with policy-injected defaults
  // would always miss the short-circuit even when disk is already
  // correct.  Falling back through to full planning in that case
  // disables the perf path on every targeted call.  The policy hook
  // returns the input unchanged when it has no opinion, so this is a
  // no-op for providers without a normalize-config policy.
  //
  // Cast: `configuredProviderRaw` is the user's `models.providers[X]`
  // entry, typed `unknown` for defensive parsing of disk content via
  // the same surface; the in-memory `cfg` value matches
  // `ProviderConfig`'s shape and is what `normalizeProviders` itself
  // accepts.
  const configuredProvider = normalizeProviderSpecificConfig(
    targetProvider,
    configuredProviderRaw as ProviderConfig,
  ) as Record<string, unknown>;
  if (!isRecord(configuredProvider)) {
    return { matches: false };
  }
  // Reuse the fingerprint-cache safe-read primitive (#73260):
  // O_NOFOLLOW open, lstat/fstat regular-file check, MAX_MODELS_JSON_BYTES
  // size cap, fail-closed on grow-past-cap.  After the round-4
  // fail-closed refactor (#73260), the primitive returns a
  // discriminated outcome.  Anything other than `hashed` (i.e.
  // `absent` or `uncacheable`) maps to "refuse short-circuit" — a
  // missing models.json must be regenerated by the planner, and an
  // unhashable models.json (oversize, symlink, I/O error) must NEVER
  // bypass full planning (CWE-345).
  const safe = await safeReadFileOutcome(targetPath, MAX_MODELS_JSON_BYTES);
  if (safe.kind !== "hashed") {
    return { matches: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(safe.raw.toString("utf8"));
  } catch {
    return { matches: false };
  }
  if (!isRecord(parsed) || !isRecord(parsed.providers)) {
    return { matches: false };
  }
  // Use Object.hasOwn to refuse inherited keys — belt-and-suspenders
  // against prototype-chain access (Aisle medium #3).
  if (!Object.hasOwn(parsed.providers, targetProvider)) {
    return { matches: false };
  }
  const diskProvider = parsed.providers[targetProvider];
  if (!isRecord(diskProvider)) {
    return { matches: false };
  }

  // Symmetric baseUrl comparison.  The previous asymmetric check
  // (`typeof configuredProvider.baseUrl === "string" && ... !== ...`)
  // skipped validation entirely when config omitted baseUrl, letting
  // an attacker-injected disk baseUrl slip through (Greptile P1
  // security + Aisle High #1 on PR #73261).  Now: any difference
  // between configured and disk baseUrl — including config-undefined
  // vs disk-string — falls through to full planning, which will
  // re-apply provider/plugin defaults and rewrite the file.  Bounded
  // depth: a hostile disk baseUrl that's an exotically-nested object
  // fails closed instead of stack-overflowing the gateway.
  if (
    !stableEqualBounded(
      configuredProvider.baseUrl,
      diskProvider.baseUrl,
      SHORT_CIRCUIT_COMPARE_MAX_DEPTH,
    )
  ) {
    return { matches: false };
  }

  const resolvedConfiguredApiKey = resolveConfiguredApiKeyForCompare(
    configuredProvider.apiKey,
    env,
  );
  if (resolvedConfiguredApiKey === null) {
    return { matches: false };
  }
  if (resolvedConfiguredApiKey !== undefined) {
    if (
      typeof diskProvider.apiKey !== "string" ||
      diskProvider.apiKey !== resolvedConfiguredApiKey
    ) {
      return { matches: false };
    }
  } else if (
    diskProvider.apiKey !== undefined &&
    !(typeof diskProvider.apiKey === "string" && diskProvider.apiKey.length === 0) &&
    !diskApiKeyMatchesUnsetConfigPlannerOutput({
      diskApiKey: diskProvider.apiKey,
      providerKey: targetProvider,
      providerAuth: configuredProvider.auth,
      env,
    })
  ) {
    // Codex P2 on PR #73261: when config has no apiKey, accept either
    // "absent" (undefined) / empty-string on disk OR a value that
    // matches what `planOpenClawModelsJson` would have persisted via
    // `resolveMissingProviderApiKey`.  Without the second case, every
    // common implicit-discovery setup (provider has models, auth comes
    // from env-var-derived markers like `OPENAI_API_KEY` or AWS SDK
    // env names) would always miss the short-circuit on every restart
    // and re-run full implicit discovery, negating the perf path even
    // though disk and config are semantically aligned.  Anything else
    // (number, null, object, array, or a string not derivable from
    // the planner's env/aws-sdk paths) still falls through to full
    // planning, which will rewrite the file.
    return { matches: false };
  }

  // Provider-level `api` drift check (Codex P1 round-5 on PR #73261).
  // The runtime consumes a provider-level `api` field at the same
  // priority as `baseUrl`/`headers`/`auth` (see
  // pi-embedded-runner/model.ts and src/agents/models-json/plan.ts):
  // it is part of the transport surface that determines which
  // upstream the gateway will hit.  Without this comparison, an
  // attacker who can write models.json could swap a provider's `api`
  // (e.g. `"openai" -> "anthropic"`) and the short-circuit would
  // re-bless it because the per-model loop only flags `api` set on
  // disk-side MODEL rows, not on the provider itself.  Symmetric
  // depth-bounded compare — any difference between configured and
  // disk `api` (including config-undefined vs disk-string) falls
  // through to full planning, which re-applies provider/plugin
  // defaults and rewrites the file.  Bounded depth keeps an exotic
  // disk shape from stack-overflowing the gateway.
  if (
    !stableEqualBounded(configuredProvider.api, diskProvider.api, SHORT_CIRCUIT_COMPARE_MAX_DEPTH)
  ) {
    return { matches: false };
  }
  // Pre-normalize configuredProvider.headers the same way the planner
  // does before persisting (Codex P2 round-7 on PR #73261:
  // "Normalize secret-ref headers before short-circuit compare").
  // Without this, any provider configured with header SecretRefs
  // (`${ENV_VAR}` strings or SecretRef objects) compares as not-equal
  // because configuredProvider holds the raw secret reference while
  // diskProvider holds the planner's marker string
  // (`<env-marker:NAME>` for env refs, the non-env marker for
  // keyring/file/etc), defeating the short-circuit on every restart
  // for the entire class of header-auth providers.
  // `normalizeHeaderValues` is idempotent for plain literal values
  // (returns headers unchanged when nothing is a secret ref), so this
  // is a safe no-op for the common no-header / literal-header case.
  // `normalizeHeaderValues` accepts the `ProviderConfig["headers"]`
  // shape; cast through `unknown` to satisfy the parameter type without
  // pulling the entire ProviderConfig type into this module.  When the
  // disk-controlled value is not an object, skip normalization and let
  // the deep compare reject it (string / number / array / null all fall
  // through to the existing strict equality check).
  const normalizedConfiguredHeaders =
    isRecord(configuredProvider.headers) || configuredProvider.headers === undefined
      ? normalizeHeaderValues({
          headers: configuredProvider.headers as Parameters<
            typeof normalizeHeaderValues
          >[0]["headers"],
          secretDefaults,
        }).headers
      : configuredProvider.headers;
  if (
    !stableEqualBounded(
      normalizedConfiguredHeaders,
      diskProvider.headers,
      SHORT_CIRCUIT_COMPARE_MAX_DEPTH,
    )
  ) {
    return { matches: false };
  }
  if (
    !stableEqualBounded(configuredProvider.auth, diskProvider.auth, SHORT_CIRCUIT_COMPARE_MAX_DEPTH)
  ) {
    return { matches: false };
  }

  // Per-model transport drift check (Codex P1 / Aisle High #2 on PR
  // #73261).  The runtime consumes per-model `baseUrl` / `api` /
  // `headers` from models.json (see `pi-embedded-runner/model.ts`); an
  // attacker who can write models.json could otherwise inject per-model
  // overrides that survive the provider-scoped short-circuit while
  // keeping provider-level fields intact.  Refuse short-circuit when
  // any disk-side model carries any transport field.  The full plan
  // path will re-apply provider/plugin defaults and rewrite the file.
  if (Array.isArray(diskProvider.models)) {
    for (const m of diskProvider.models) {
      if (!isRecord(m)) {
        return { matches: false };
      }
      for (const f of PER_MODEL_TRANSPORT_FIELDS) {
        if (Object.hasOwn(m, f)) {
          return { matches: false };
        }
      }
    }
  } else if (diskProvider.models !== undefined) {
    // models is present but not an array — malformed disk row.  Refuse
    // short-circuit so the planner rewrites a well-formed structure.
    return { matches: false };
  }

  // Model-list subset check (Codex P1 round-8 on PR #73261:
  // "Compare configured models before short-circuiting provider hit").
  // The prior per-model loop only validated TRANSPORT shape; it never
  // checked that the set of configured model ids was reflected on
  // disk.  Result: a config edit that adds a new model (without
  // touching apiKey / baseUrl / api / headers / auth) hits the
  // short-circuit, leaves models.json stale, and `resolveModelAsync`
  // misses the newly configured model until some later full reconcile.
  // With this commit wiring `targetProvider` into the embedded
  // runner paths, that staleness window is now reachable from
  // gateway hot paths and must be closed.
  //
  // Contract: when `configuredProvider.models` is a non-empty array
  // (explicit mode — user enumerated which models they want), every
  // configured model id MUST appear on disk.  Disk may legitimately
  // contain MORE models than config (implicit discovery /
  // plugin-contributed entries), so we use a subset check, not
  // strict equality.  Implicit-only mode (`models: []` or omitted)
  // skips the comparison — the disk content reflects discovery, not
  // config, and the transport check above is sufficient.
  //
  // Adversarial / malformed configured.models entries (non-record
  // non-string, missing id, prototype-key collision) fail closed:
  // we cannot reason about them, so we refuse the short-circuit.
  const configuredIds = collectShortCircuitModelIds(configuredProvider.models);
  if (configuredIds === null) {
    return { matches: false };
  }
  // We only need diskIds when either explicit-mode subset check fires
  // or implicit-mode `targetModelId` is provided (Codex P2 round-9 on
  // PR #73261, models-config.ts:997).  Compute lazily so adversarial
  // disk model rows still fail closed in both branches without
  // duplicating the parse.
  let diskIds: Set<string> | null | undefined;
  const ensureDiskIds = (): Set<string> | null => {
    if (diskIds === undefined) {
      diskIds = collectShortCircuitModelIds(diskProvider.models);
    }
    return diskIds;
  };
  if (configuredIds.size > 0) {
    const ids = ensureDiskIds();
    if (ids === null) {
      return { matches: false };
    }
    for (const id of configuredIds) {
      if (!ids.has(id)) {
        return { matches: false };
      }
    }
  } else if (typeof targetModelId === "string" && targetModelId.length > 0) {
    // Implicit-only mode (`configuredProvider.models` empty/omitted)
    // means `models.json` reflects discovery, not config.  The prior
    // contract skipped *all* model-id validation in this branch and
    // returned a structural "match" even when the caller's requested
    // model wasn't on disk yet (Codex P2 round-9: "Check requested
    // model on implicit-only short-circuit hits", models-config.ts:997).
    // Cold-start / stale-disk implicit-discovery setups can then
    // bypass `resolveImplicitProviders`, leaving `resolveModelAsync`
    // to fail with `Unknown model` until another path forces a full
    // reconcile.
    //
    // Closing that hole: when the embedded caller passes
    // `targetModelId`, require the requested id to be present on
    // disk before short-circuiting.  Anything else (malformed disk
    // models, missing id) falls through to full planning, which will
    // run discovery and rewrite the file.  Implicit callers that
    // don't know which model they're about to use (`targetModelId`
    // omitted) keep the prior provider-shape-only contract — they
    // never had per-model assertions to begin with.
    const ids = ensureDiskIds();
    if (ids === null) {
      return { matches: false };
    }
    if (!ids.has(targetModelId)) {
      return { matches: false };
    }
  }

  return { matches: true, validatedModelsJsonOutcome: { kind: "hashed", hash: safe.hash } };
}

/**
 * Extract a Set of model ids from a provider's `models` field for the
 * targetProvider short-circuit subset check (Codex P1 round-8 on PR
 * #73261).  Accepts the two shapes the runtime produces:
 *  - bare string entries (e.g. `"gpt-5"`)
 *  - record entries with a string `id` field (e.g. `{ id: "gpt-5", ... }`)
 *
 * Returns:
 *  - `null` when the input is malformed in a way that should fail closed
 *    (non-array with non-undefined value, non-record/non-string entries,
 *    record entries missing a string `id`, prototype-chain id collisions).
 *  - an empty Set when `models` is undefined OR an empty array (legitimate
 *    "implicit-only" mode — caller skips the subset check in that case).
 *  - a populated Set otherwise.
 */
function collectShortCircuitModelIds(models: unknown): Set<string> | null {
  if (models === undefined) {
    return new Set();
  }
  if (!Array.isArray(models)) {
    return null;
  }
  const ids = new Set<string>();
  for (const entry of models) {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (!trimmed) {
        return null;
      }
      ids.add(trimmed);
      continue;
    }
    if (!isRecord(entry)) {
      return null;
    }
    // Use Object.hasOwn to refuse prototype-chain id collisions
    // (consistent with the same guard around `parsed.providers`
    // earlier in this function).
    if (!Object.hasOwn(entry, "id")) {
      return null;
    }
    const id = (entry as { id: unknown }).id;
    if (typeof id !== "string" || !id.trim()) {
      return null;
    }
    ids.add(id.trim());
  }
  return ids;
}

/**
 * Provider-scoped readyCache key for successful short-circuit results.
 * Uses a `\0sc:<provider>` suffix so non-targeted callers (whose cache
 * key is the unsuffixed `${targetPath}\0${fingerprint}`) cannot collide
 * with these entries — the short-circuit only validated ONE provider,
 * and a non-targeted call must run a full plan to validate all of them
 * (Codex P1 on PR #73261).  The null-byte separators cannot appear in
 * provider ids or in the fingerprint hex digest.
 */
function modelsJsonScopedShortCircuitCacheKey(
  targetPath: string,
  fingerprint: string,
  targetProvider: string,
  targetModelId: string | undefined,
): string {
  // Fold `targetModelId` into the scoped key (Codex P2 round-9 on PR
  // #73261, models-config.ts:997 follow-on).  In implicit-only mode
  // we now require the requested model to be on disk before blessing
  // the short-circuit; the cache must reflect that scope so a hit
  // cached for model X can't be reused for model Y under the same
  // (provider, fingerprint, models.json content) tuple when Y isn't
  // on disk.  The empty-suffix arm preserves the prior key shape for
  // callers that don't pass `targetModel`.
  const modelSuffix = targetModelId ? `\0m:${targetModelId}` : "";
  return `${targetPath}\0${fingerprint}\0sc:${targetProvider}${modelSuffix}`;
}

/** Ensures models.json and plugin catalog sidecars are current for an agent. */
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
  // Read the auth-profile store BEFORE deciding whether to read or write
  // the readyCache.  When the outcome is `uncacheable` (DB read failure or
  // pathological payload) we must bypass the cache entirely (fail closed):
  // otherwise a transient read error could let a credential change keep
  // hitting a stale entry, and we'd write dead entries we could never evict.
  const authProfilesOutcome = readAuthProfilesStableOutcome(agentDir);
  const cacheable = authProfilesOutcome.kind !== "uncacheable";

  const planAndWrite = (
    fingerprintForEntry: string,
  ): Promise<{
    fingerprint: string;
    modelsJsonOutcome: ContentHashOutcome;
    pluginCatalogsOutcome: ContentHashOutcome;
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
        // No models.json write performed; still reconcile generated plugin
        // catalogs (write/remove) so plugin-provider files track config even
        // on a skip, then capture whatever's currently on disk so the cache
        // can detect external edits between now and the next call.
        const wrotePluginCatalog = await writePluginCatalogsForModelsJson({
          agentDir,
          pluginCatalogWrites: plan.pluginCatalogWrites,
        });
        const modelsJsonOutcome = await readModelsJsonContentOutcome(targetPath);
        const pluginCatalogsOutcome = await readPluginCatalogsContentOutcome(agentDir);
        return {
          fingerprint: fingerprintForEntry,
          modelsJsonOutcome,
          pluginCatalogsOutcome,
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
        const pluginCatalogsOutcome = await readPluginCatalogsContentOutcome(agentDir);
        return {
          fingerprint: fingerprintForEntry,
          modelsJsonOutcome,
          pluginCatalogsOutcome,
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
      // point — for both root models.json and the generated plugin
      // catalog sidecars the planner owns.
      const modelsJsonOutcome = await readModelsJsonContentOutcome(targetPath);
      const pluginCatalogsOutcome = await readPluginCatalogsContentOutcome(agentDir);
      return {
        fingerprint: fingerprintForEntry,
        modelsJsonOutcome,
        pluginCatalogsOutcome,
        result: { agentDir, wrote: true },
      };
    });

  if (!cacheable) {
    // Cache-bypass mode: auth-profiles is `uncacheable`, so we re-plan
    // unconditionally and never touch the readyCache.  The sentinel
    // fingerprint passed below is informational only — we deliberately
    // do not READ from or WRITE to the readyCache in this mode, so the
    // entry never lands in the global map and cannot collide with a
    // legitimate cached entry.  This also covers the targetProvider
    // short-circuit: it is gated on `cacheable`, so an `uncacheable`
    // auth-profiles state forces a full re-plan even when the caller
    // hinted a provider, instead of letting the short-circuit ride on a
    // stale or oversized credential file.
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
    // Warm in-memory cache hit: same inputs, already-planned result.
    // This is the fastest path — no disk I/O at all.
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
    // Two-factor hit also requires the generated plugin catalog sidecars to
    // be unchanged since write time: a deleted/tampered sidecar must force a
    // re-plan so the planner can rewrite/remove it before `ModelRegistry`
    // consumes stale provider rows (Codex P1 on PR #90741).
    const currentPluginCatalogsOutcome = await readPluginCatalogsContentOutcome(agentDir);
    if (
      modelsContentOutcomesMatch(currentModelsJsonOutcome, settled.modelsJsonOutcome) &&
      modelsContentOutcomesMatch(currentPluginCatalogsOutcome, settled.pluginCatalogsOutcome)
    ) {
      await ensureModelsFileModeForModelsJson(targetPath);
      return settled.result;
    }
  }

  // --- TARGETPROVIDER SHORT-CIRCUIT FAST PATH ---
  // The fingerprint cache missed (cold start, gateway restart, or
  // input drift), but the caller hinted which provider it intends to
  // use.  If the on-disk provider entry STRUCTURALLY matches the
  // current config (apiKey env-var name, baseUrl, api, headers, auth,
  // and per-model transport surface all clean), skip the heavy
  // implicit-discovery pipeline.  Any drift (rotated key,
  // attacker-tampered baseUrl/api/headers/auth, per-model transport
  // overrides, missing fields) falls through to full plan + write.
  //
  // Order matters: we run AFTER the readyCache check so warm callers
  // skip the disk read entirely.  Successful short-circuits are cached
  // under a PROVIDER-SCOPED key (`...\0sc:<provider>`) so they never
  // poison the global readyCache — only the validated provider can
  // reuse the entry, and a later non-targeted call still runs a full
  // plan to validate every other provider (Codex P1 on PR #73261).
  //
  // The scoped cache hit uses the same fail-closed `ContentHashOutcome`
  // contract as the global cache hit above (Codex P2 round-4 follow-up
  // on PR #73261): an `uncacheable` models.json outcome — typically a
  // >1 MiB or symlinked file — never compares equal so the scoped
  // entry cannot ride a `null === null` compare to a stale hit.  When
  // the on-disk file is unhashable we drop the scoped entry and fall
  // through to a fresh structural check (which itself uses the
  // bounded-memory `safeReadFileOutcome` and refuses to short-circuit
  // on `uncacheable`).
  const targetProvider = options?.targetProvider?.trim();
  if (targetProvider) {
    const scopedTargetModelId = options?.targetModel?.trim() || undefined;
    const scopedKey = modelsJsonScopedShortCircuitCacheKey(
      targetPath,
      fingerprint,
      targetProvider,
      scopedTargetModelId,
    );
    const scopedCached = MODELS_JSON_STATE.readyCache.get(scopedKey);
    if (scopedCached) {
      const settled = await scopedCached;
      // Same two-factor verification as the global cache hit above:
      // fingerprint identity is necessary but not sufficient — also
      // verify the on-disk models.json outcome hasn't drifted since
      // the short-circuit blessed it.  Uncacheable outcomes never
      // match (fail-closed contract), so any drift invalidates the
      // scoped entry and falls through to a fresh check.
      const currentModelsJsonOutcome = await readModelsJsonContentOutcome(targetPath);
      const currentPluginCatalogsOutcome = await readPluginCatalogsContentOutcome(agentDir);
      if (
        modelsContentOutcomesMatch(currentModelsJsonOutcome, settled.modelsJsonOutcome) &&
        modelsContentOutcomesMatch(currentPluginCatalogsOutcome, settled.pluginCatalogsOutcome)
      ) {
        await ensureModelsFileModeForModelsJson(targetPath);
        return settled.result;
      }
      MODELS_JSON_STATE.readyCache.delete(scopedKey);
    }

    const explicitProviders = cfg.models?.providers ?? {};
    const configuredProvider = Object.hasOwn(explicitProviders, targetProvider)
      ? explicitProviders[targetProvider]
      : undefined;
    if (configuredProvider) {
      const env = createConfigRuntimeEnv(cfg);
      const matchOutcome = await readExistingProviderMatchesConfig(
        targetPath,
        targetProvider,
        configuredProvider,
        env,
        cfg.secrets?.defaults,
        scopedTargetModelId,
      );
      if (matchOutcome.matches) {
        await ensureModelsFileModeForModelsJson(targetPath);
        const result = { agentDir, wrote: false };
        // Cache the SAME models.json outcome that the structural
        // check just validated, instead of issuing a second
        // `readModelsJsonContentOutcome(targetPath)` here (Codex P2
        // round-10 follow-up on PR #73261, models-config.ts:1397).
        // The previous code did a second disk read AFTER
        // validation, then stored THAT outcome in the scoped cache.
        // If `models.json` was replaced on disk between the two
        // reads (TOCTOU), the scoped cache would store the hash of
        // UNVALIDATED bytes — and a later targeted call hitting that
        // entry would compare current disk against the swapped-in
        // hash and accept it as "the validated snapshot," blessing
        // attacker-controlled provider transport (api / baseUrl /
        // headers consumed by `pi-embedded-runner/model.ts`).
        //
        // By threading the validated outcome straight back from
        // `readExistingProviderMatchesConfig` we close the window:
        // the cached hash is provably the hash of the bytes the
        // structural check actually inspected.  A subsequent
        // disk-side swap is detected on the next call's
        // drift-check (`modelsContentOutcomesMatch` against current
        // disk), which falls through to a full plan.
        //
        // The validated outcome from the success path is always
        // `hashed` (failure paths return `{ matches: false }` before
        // we get here), so populating the cache is unconditional in
        // practice; we keep the `kind !== "uncacheable"` guard as
        // belt-and-suspenders against future shape drift in
        // `ContentHashOutcome`.
        const modelsJsonOutcome = matchOutcome.validatedModelsJsonOutcome;
        // The short-circuit path does not re-run the planner, so it neither
        // writes nor reconciles the generated plugin catalog sidecars. Capture
        // their current on-disk outcome so a later sidecar drift still
        // invalidates this scoped entry on the next hit (Codex P1 on PR #90741).
        // Fail closed if the sidecars are unhashable: an `uncacheable` outcome
        // would poison every future hit anyway, so skip caching entirely.
        const pluginCatalogsOutcome = await readPluginCatalogsContentOutcome(agentDir);
        if (
          modelsJsonOutcome.kind !== "uncacheable" &&
          pluginCatalogsOutcome.kind !== "uncacheable"
        ) {
          MODELS_JSON_STATE.readyCache.set(
            scopedKey,
            Promise.resolve({ fingerprint, modelsJsonOutcome, pluginCatalogsOutcome, result }),
          );
        }
        return result;
      }
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
    const refreshedAuthOutcome = readAuthProfilesStableOutcome(agentDir);
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
          pluginCatalogsOutcome: settled.pluginCatalogsOutcome,
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
