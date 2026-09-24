// Per-(account, database) high-water of the last durably admitted chat.db rowid.
// It advances only after the SQLite ingress enqueue, then seeds `since_rowid`
// on startup. GUID-keyed ingress tombstones make over-replay safe, while rows
// journaled before a crash resume from the queue. The store key also includes
// the database identity: a high-water from one chat.db must never seed
// since_rowid for a different one, or repointing `dbPath`/`remoteHost` to a
// lower-rowid database silently suppresses every row in it forever (#99638).
import { createHash } from "node:crypto";
import path from "node:path";
import { resolveIMessageHomeDir } from "../cli-path.js";
import { getIMessageRuntime } from "../runtime.js";

const IMESSAGE_RECOVERY_CURSOR_NAMESPACE = "imessage.recovery-cursor";
const IMESSAGE_RECOVERY_CURSOR_MAX_ENTRIES = 64;
const RECOVERY_CURSOR_STORE_OPTIONS = {
  namespace: IMESSAGE_RECOVERY_CURSOR_NAMESPACE,
  maxEntries: IMESSAGE_RECOVERY_CURSOR_MAX_ENTRIES,
};

// Retired catchup cursor, seeded into the recovery cursor once on upgrade (see
// loadIMessageRecoveryCursor) so a user who had catchup enabled still recovers
// messages missed across the upgrade restart.
const LEGACY_CATCHUP_CURSOR_NAMESPACE = "imessage.catchup-cursors";
const LEGACY_CATCHUP_CURSOR_MAX_ENTRIES = 256;

type RecoveryCursor = { lastRowid: number };

function openRecoveryCursorStore() {
  return getIMessageRuntime().state.openKeyedStore<RecoveryCursor>(RECOVERY_CURSOR_STORE_OPTIONS);
}

// Canonicalize a local chat.db path (expand a leading ~, then resolve) so the
// implicit default and any explicit spelling of the same file share one identity.
function normalizeLocalDbPath(dbPath: string): string {
  let resolved = dbPath.trim();
  if (resolved.startsWith("~")) {
    const home = resolveIMessageHomeDir();
    if (home) {
      resolved = path.join(home, resolved.slice(1).replace(/^\/+/, ""));
    }
  }
  return path.resolve(resolved);
}

/**
 * Stable identity for the watched Messages database. A changed identity means a
 * different chat.db (different `dbPath`, custom `cliPath`, or a remote host),
 * whose rowids share no ordering with the previous one, so the cursor must not
 * carry across. Local paths are canonicalized so the implicit default and an
 * explicit path to the same chat.db resolve to one identity.
 */
export function resolveIMessageRecoveryCursorDbIdentity(params: {
  cliPath?: string;
  dbPath?: string;
  remoteHost?: string;
}): string {
  const remoteHost = params.remoteHost?.trim();
  if (remoteHost) {
    // Remote paths cannot be resolved locally; key by host + raw remote path.
    return `remote:${remoteHost}:${params.dbPath?.trim() || "default"}`;
  }
  const dbPath = params.dbPath?.trim();
  if (dbPath) {
    return `local:${normalizeLocalDbPath(dbPath)}`;
  }
  // No explicit dbPath: the default imsg binary watches the default chat.db, so
  // resolve it to the same concrete path an explicit config would spell. A
  // custom cliPath (e.g. an SSH wrapper whose host is not auto-detected) can
  // front a distinct database, so keep those distinct instead.
  const cliPath = params.cliPath?.trim();
  const isDefaultCli = !cliPath || cliPath === "imsg" || path.basename(cliPath) === "imsg";
  if (isDefaultCli) {
    const home = resolveIMessageHomeDir();
    return home
      ? `local:${normalizeLocalDbPath(path.join(home, "Library", "Messages", "chat.db"))}`
      : "local:default";
  }
  return `local:cli:${cliPath}`;
}

// Composite key: one high-water per (account, database). The NUL separator
// cannot appear in an account id or identity string, so a composite key never
// collides with the legacy account-only key adopted below.
function recoveryCursorStoreKey(accountId: string, dbIdentity: string): string {
  return `${accountId}\u0000${dbIdentity}`;
}

type RecoveryCursorUpdate =
  | { kind: "advance"; rowid: number }
  | { kind: "rewind"; rowid: number; expectedRowid: number };

function decideRecoveryCursorUpdate(
  current: RecoveryCursor | undefined,
  update: RecoveryCursorUpdate,
): RecoveryCursor | undefined {
  if (update.kind === "rewind") {
    if (current?.lastRowid !== update.expectedRowid) {
      return undefined;
    }
  } else if (current && current.lastRowid >= update.rowid) {
    return undefined;
  }
  return { lastRowid: update.rowid };
}

async function applyRecoveryCursorUpdate(
  key: string,
  update: RecoveryCursorUpdate,
): Promise<RecoveryCursor | undefined> {
  const state = getIMessageRuntime().state;
  const store = state.openKeyedStore<RecoveryCursor>(RECOVERY_CURSOR_STORE_OPTIONS);
  if (!store.observe || !store.compareAndApply) {
    // Published 2026.9.4 hosts have atomic update but no comparison methods.
    // Remove this branch when the declared host floor requires comparisons.
    const legacy = state.openSyncKeyedStore<RecoveryCursor>(RECOVERY_CURSOR_STORE_OPTIONS);
    if (!legacy.update) {
      throw new Error("iMessage recovery cursor persistence requires atomic update support.");
    }
    let result: RecoveryCursor | undefined;
    legacy.update(key, (current) => {
      const next = decideRecoveryCursorUpdate(current, update);
      result = next ?? current;
      return next;
    });
    return result;
  }

  const observe = store.observe.bind(store);
  const compareAndApply = store.compareAndApply.bind(store);
  let observation = await observe(key);
  for (;;) {
    const next = decideRecoveryCursorUpdate(observation.value, update);
    if (!next) {
      return observation.value;
    }
    const result = await compareAndApply(key, observation.comparison, {
      operation: "update",
      action: "set",
      value: next,
    });
    if (result.status !== "conflict") {
      return next;
    }
    observation = result.current;
  }
}

async function readRecoveryCursor(accountId: string, dbIdentity: string): Promise<number | null> {
  try {
    const store = openRecoveryCursorStore();
    const key = recoveryCursorStoreKey(accountId, dbIdentity);
    const value = await store.lookup(key);
    if (value) {
      return Number.isFinite(value.lastRowid) ? value.lastRowid : null;
    }
    // One-time upgrade adoption: cursors written before database scoping were
    // keyed by accountId alone. Adopt such an entry for the active database so
    // the upgrade restart still replays downtime rows, then consume it so a
    // later dbPath change cannot inherit this database's high-water.
    const legacy = await store.consume(accountId);
    if (legacy && Number.isFinite(legacy.lastRowid)) {
      await store.registerIfAbsent(key, { lastRowid: legacy.lastRowid });
      const adopted = await store.lookup(key);
      return adopted && Number.isFinite(adopted.lastRowid) ? adopted.lastRowid : null;
    }
    return null;
  } catch {
    return null;
  }
}

// One-time, self-cleaning migration: when the recovery cursor is empty (first
// startup after upgrade or a fresh install), seed it from the retired catchup
// cursor's lastSeenRowid and consume the legacy entry so this never runs again.
async function migrateLegacyCatchupCursor(
  accountId: string,
  dbIdentity: string,
): Promise<number | null> {
  try {
    const legacy = getIMessageRuntime().state.openKeyedStore<{ lastSeenRowid?: unknown }>({
      namespace: LEGACY_CATCHUP_CURSOR_NAMESPACE,
      maxEntries: LEGACY_CATCHUP_CURSOR_MAX_ENTRIES,
    });
    const key = createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 32);
    const value = await legacy.consume(key);
    const rowid =
      typeof value?.lastSeenRowid === "number" && Number.isFinite(value.lastSeenRowid)
        ? value.lastSeenRowid
        : null;
    if (rowid !== null) {
      await advanceIMessageRecoveryCursor(accountId, dbIdentity, rowid);
    }
    return rowid;
  } catch {
    return null;
  }
}

async function reconcileRecoveryCursorToWatermark(
  accountId: string,
  dbIdentity: string,
  cursorRowid: number | null,
  watermarkRowid: number | null,
): Promise<number | null> {
  if (cursorRowid === null || watermarkRowid === null || cursorRowid <= watermarkRowid) {
    return cursorRowid;
  }
  try {
    const current = await applyRecoveryCursorUpdate(recoveryCursorStoreKey(accountId, dbIdentity), {
      kind: "rewind",
      rowid: watermarkRowid,
      expectedRowid: cursorRowid,
    });
    return current?.lastRowid ?? watermarkRowid;
  } catch {
    return watermarkRowid;
  }
}

/**
 * Last durably admitted rowid for this account on `dbIdentity`, or null when
 * none is recorded yet (including when the only stored cursor belongs to a
 * different database).
 */
export async function loadIMessageRecoveryCursor(
  accountId: string,
  dbIdentity: string,
  options: { migrateLegacyCatchup?: boolean; watermarkRowid?: number | null } = {},
): Promise<number | null> {
  const watermarkRowid =
    typeof options.watermarkRowid === "number" && Number.isFinite(options.watermarkRowid)
      ? options.watermarkRowid
      : null;
  const current = await readRecoveryCursor(accountId, dbIdentity);
  if (current !== null) {
    return await reconcileRecoveryCursorToWatermark(accountId, dbIdentity, current, watermarkRowid);
  }
  if (options.migrateLegacyCatchup === false) {
    return null;
  }
  return await reconcileRecoveryCursorToWatermark(
    accountId,
    dbIdentity,
    await migrateLegacyCatchupCursor(accountId, dbIdentity),
    watermarkRowid,
  );
}

/** Advance the cursor forward to `rowid` (monotonic per database; never rewinds). */
export async function advanceIMessageRecoveryCursor(
  accountId: string,
  dbIdentity: string,
  rowid: number,
): Promise<void> {
  if (!Number.isFinite(rowid)) {
    return;
  }
  try {
    await applyRecoveryCursorUpdate(recoveryCursorStoreKey(accountId, dbIdentity), {
      kind: "advance",
      rowid,
    });
  } catch {
    // Best effort: a failed cursor write just means we replay a little more
    // next startup, which durable ingress tombstones reject by GUID.
  }
}
