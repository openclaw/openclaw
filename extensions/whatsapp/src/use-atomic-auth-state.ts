/**
 * Atomic file-based auth state for Baileys.
 *
 * Replaces `useMultiFileAuthState` which writes 800+ individual JSON files
 * and is prone to corruption on Windows when writes overlap with disconnects.
 *
 * This adapter:
 *  - Consolidates all key material into a single `auth-state.json`
 *  - Uses atomic writes (write to `.tmp`, rename over original)
 *  - Keeps a rotating backup (`auth-state.json.bak`)
 *  - Auto-migrates from the old multi-file layout on first run
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
// Re-export the Baileys primitives we need from the runtime boundary
// so we don't duplicate the import path.
import { initAuthCreds, BufferJSON, proto } from "./use-atomic-auth-state.runtime.js";

const STATE_FILE = "auth-state.json";
const STATE_BAK = "auth-state.json.bak";
const STATE_TMP = "auth-state.json.tmp";

interface KeyStore {
  get(type: string, ids: string[]): Promise<Record<string, unknown>>;
  set(data: Record<string, Record<string, unknown>>): Promise<void>;
}

interface AuthState {
  creds: unknown;
  keys: Record<string, Record<string, unknown>>;
}

/**
 * Read and parse the consolidated state file, falling back to backup.
 */
function readStateSync(stateDir: string): AuthState | null {
  const logger = getChildLogger({ module: "atomic-auth" });
  const primary = path.join(stateDir, STATE_FILE);
  const backup = path.join(stateDir, STATE_BAK);

  for (const filePath of [primary, backup]) {
    try {
      if (!fs.existsSync(filePath)) {
        continue;
      }
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw, BufferJSON.reviver) as AuthState;
      if (parsed?.creds) {
        if (filePath === backup) {
          logger.warn("restored auth state from backup");
        }
        return parsed;
      }
    } catch {
      // try next file
    }
  }
  return null;
}

/**
 * Atomic write: serialise → write to .tmp → rename over target.
 * On Windows, rename over an existing file works with fs.renameSync.
 */
function writeStateAtomicSync(stateDir: string, state: AuthState): void {
  const target = path.join(stateDir, STATE_FILE);
  const tmp = path.join(stateDir, STATE_TMP);
  const bak = path.join(stateDir, STATE_BAK);

  const json = JSON.stringify(state, BufferJSON.replacer, 0);
  fs.writeFileSync(tmp, json, "utf-8");

  // Rotate current → backup before overwriting
  try {
    if (fs.existsSync(target)) {
      fs.copyFileSync(target, bak);
    }
  } catch {
    // best-effort backup
  }

  fs.renameSync(tmp, target);
}

/**
 * Migrate from the old multi-file auth state (800+ .json files) to
 * the consolidated format. Non-destructive — old files are left in place
 * and can be cleaned up later.
 */
async function migrateFromMultiFile(stateDir: string): Promise<AuthState | null> {
  const logger = getChildLogger({ module: "atomic-auth" });
  const credsPath = path.join(stateDir, "creds.json");

  if (!fs.existsSync(credsPath)) {
    return null;
  }

  try {
    const credsRaw = await fsp.readFile(credsPath, "utf-8");
    const creds = JSON.parse(credsRaw, BufferJSON.reviver);

    const keys: Record<string, Record<string, unknown>> = {};
    const entries = await fsp.readdir(stateDir);

    for (const entry of entries) {
      if (entry === "creds.json" || entry === "creds.json.bak") {
        continue;
      }
      if (!entry.endsWith(".json")) {
        continue;
      }

      // Parse category-id pattern: "pre-key-1.json" → type="pre-key", id="1"
      const nameWithoutExt = entry.slice(0, -5); // strip .json
      const lastDash = nameWithoutExt.lastIndexOf("-");
      if (lastDash < 1) {
        continue;
      }

      // Baileys uses "type-id.json" format. Types can contain dashes
      // (e.g. "app-state-sync-key-AAAAAA5u.json", "pre-key-1.json")
      // We need to detect the known type prefixes.
      const knownTypes = [
        "app-state-sync-key",
        "app-state-sync-version",
        "pre-key",
        "sender-key",
        "sender-key-memory",
        "session",
        "device-list",
        "lid-mapping",
      ];

      let type: string | null = null;
      let id: string | null = null;

      for (const t of knownTypes) {
        if (nameWithoutExt.startsWith(t + "-")) {
          type = t;
          id = nameWithoutExt.slice(t.length + 1);
          break;
        }
      }

      if (!type || !id) {
        continue;
      }

      try {
        const raw = await fsp.readFile(path.join(stateDir, entry), "utf-8");
        let value = JSON.parse(raw, BufferJSON.reviver);
        if (type === "app-state-sync-key" && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        if (!keys[type]) {
          keys[type] = {};
        }
        keys[type][id] = value;
      } catch {
        // skip corrupt files
      }
    }

    const state: AuthState = { creds, keys };
    logger.info(
      {
        keyTypes: Object.keys(keys).length,
        totalKeys: Object.values(keys).reduce((n, v) => n + Object.keys(v).length, 0),
      },
      "migrated multi-file auth state to consolidated format",
    );
    return state;
  } catch (err) {
    logger.warn({ error: String(err) }, "failed to migrate multi-file auth state");
    return null;
  }
}

/**
 * Drop-in replacement for Baileys' `useMultiFileAuthState`.
 * Returns the same `{ state, saveCreds }` contract.
 */
export async function useAtomicAuthState(folder: string) {
  await fsp.mkdir(folder, { recursive: true });

  // 1. Try consolidated state file
  let stateData = readStateSync(folder);

  // 2. Fall back to migration from multi-file
  if (!stateData) {
    stateData = await migrateFromMultiFile(folder);
    if (stateData) {
      writeStateAtomicSync(folder, stateData);
    }
  }

  // 3. Fresh install — no existing state
  if (!stateData) {
    stateData = { creds: initAuthCreds(), keys: {} };
    writeStateAtomicSync(folder, stateData);
  }

  const creds = stateData.creds;
  const keys = stateData.keys;

  // Debounce writes — batch rapid key updates
  let writePending = false;
  let writeTimer: ReturnType<typeof setTimeout> | null = null;
  const WRITE_DEBOUNCE_MS = 500;

  function scheduleWrite(): void {
    if (writeTimer) {
      return;
    }
    writePending = true;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      if (writePending) {
        writePending = false;
        try {
          writeStateAtomicSync(folder, { creds, keys });
        } catch {
          // Will retry on next scheduleWrite
          writePending = true;
        }
      }
    }, WRITE_DEBOUNCE_MS);
  }

  const keyStore: KeyStore = {
    get: async (type, ids) => {
      const data: Record<string, unknown> = {};
      for (const id of ids) {
        let value = keys[type]?.[id] ?? null;
        if (type === "app-state-sync-key" && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value as Record<string, unknown>);
        }
        data[id] = value;
      }
      return data;
    },
    set: async (data) => {
      for (const category in data) {
        if (!keys[category]) {
          keys[category] = {};
        }
        for (const id in data[category]) {
          const value = data[category][id];
          if (value) {
            keys[category][id] = value;
          } else {
            delete keys[category][id];
          }
        }
      }
      scheduleWrite();
    },
  };

  return {
    state: {
      creds,
      keys: keyStore,
    },
    saveCreds: async () => {
      // Flush immediately (creds changes are critical)
      if (writeTimer) {
        clearTimeout(writeTimer);
        writeTimer = null;
      }
      writePending = false;
      writeStateAtomicSync(folder, { creds, keys });
    },
  };
}
