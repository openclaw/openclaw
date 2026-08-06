/**
 * Doctor migration contract for Active Memory state. It moves legacy per-session
 * toggle JSON into the plugin state keyed store used by current runtimes.
 */
import crypto from "node:crypto";
import path from "node:path";
import {
  archiveLegacyStateSource,
  type PluginDoctorStateMigration,
  type PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor";
import { readRegularFile } from "openclaw/plugin-sdk/security-runtime";

type ActiveMemoryToggleEntry = {
  sessionKey: string;
  disabled: boolean;
  updatedAt: number;
};

const TOGGLE_STATE_FILE = "session-toggles.json";
const SESSION_TOGGLES_NAMESPACE = "session-toggles";
const MAX_TOGGLE_ENTRIES = 10_000;
export const LEGACY_TOGGLE_STATE_MAX_BYTES = 8 * 1024 * 1024;
export const LEGACY_TOGGLE_RECOVERY_MAX_BYTES = 64 * 1024 * 1024;

function resolveToggleStatePath(stateDir: string): string {
  return path.join(stateDir, "plugins", "active-memory", TOGGLE_STATE_FILE);
}

function activeMemoryToggleKey(sessionKey: string): string {
  return crypto.createHash("sha256").update(sessionKey, "utf8").digest("hex");
}

function normalizeLegacyUpdatedAt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function isLegacyToggleStateOversizedError(err: unknown, maxBytes: number): boolean {
  return err instanceof Error && err.message.includes(`File exceeds ${maxBytes} bytes`);
}

/**
 * Parses legacy toggle JSON with the same tolerant per-record semantics the
 * normal migration always used: malformed records are skipped, non-true
 * disabled values are ignored, invalid timestamps are normalized, and a
 * malformed document yields no entries instead of a partial import.
 */
function parseLegacyToggleEntries(raw: string): ActiveMemoryToggleEntry[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return [];
    }
    const sessions = (parsed as { sessions?: unknown }).sessions;
    if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) {
      return [];
    }
    const entries: ActiveMemoryToggleEntry[] = [];
    for (const [sessionKey, value] of Object.entries(sessions)) {
      if (!sessionKey.trim() || !value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      if ((value as { disabled?: unknown }).disabled !== true) {
        continue;
      }
      const updatedAt = normalizeLegacyUpdatedAt((value as { updatedAt?: unknown }).updatedAt);
      entries.push({ sessionKey, disabled: true, updatedAt });
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Reads a legacy toggle source through the bounded SDK file reader. The fast
 * path uses the smaller cap; oversized sources are retried with the recovery
 * cap so valid opt-outs are still preserved through the same JSON.parse path.
 */
async function readLegacyToggleEntries(
  filePath: string,
  maxBytes: number,
): Promise<{ entries: ActiveMemoryToggleEntry[]; oversized: boolean }> {
  try {
    const { buffer } = await readRegularFile({ filePath, maxBytes });
    return { entries: parseLegacyToggleEntries(buffer.toString("utf8")), oversized: false };
  } catch (err) {
    if (isLegacyToggleStateOversizedError(err, maxBytes)) {
      return { entries: [], oversized: true };
    }
    return { entries: [], oversized: false };
  }
}

function previewForEntries(entries: ActiveMemoryToggleEntry[]): string {
  return `- Active Memory session toggles: ${entries.length} ${entries.length === 1 ? "entry" : "entries"} -> plugin state (${SESSION_TOGGLES_NAMESPACE})`;
}

async function migrateToggleEntriesToPluginState(params: {
  filePath: string;
  entries: ActiveMemoryToggleEntry[];
  context: PluginDoctorStateMigrationContext;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const store = params.context.openPluginStateKeyedStore<ActiveMemoryToggleEntry>({
    namespace: SESSION_TOGGLES_NAMESPACE,
    maxEntries: MAX_TOGGLE_ENTRIES,
  });
  const existingKeys = new Set((await store.entries()).map((entry) => entry.key));
  const missingEntries = params.entries.filter(
    (entry) => !existingKeys.has(activeMemoryToggleKey(entry.sessionKey)),
  );
  if (missingEntries.length > MAX_TOGGLE_ENTRIES - existingKeys.size) {
    warnings.push(
      `Skipped Active Memory session toggle migration because plugin state has room for ${MAX_TOGGLE_ENTRIES - existingKeys.size} of ${missingEntries.length} missing entries; left legacy source in place`,
    );
    return { changes, warnings };
  }
  let imported = 0;
  for (const entry of params.entries) {
    const key = activeMemoryToggleKey(entry.sessionKey);
    if (existingKeys.has(key)) {
      continue;
    }
    await store.register(key, entry);
    existingKeys.add(key);
    imported++;
  }
  if (imported > 0) {
    changes.push(
      `Migrated ${imported} Active Memory session toggle ${imported === 1 ? "entry" : "entries"} -> plugin state`,
    );
  }
  await archiveLegacyStateSource({
    filePath: params.filePath,
    label: "Active Memory session toggles",
    changes,
    warnings,
  });
  return { changes, warnings };
}

/** State migrations exposed to OpenClaw doctor for Active Memory. */
export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "active-memory-session-toggles-json-to-plugin-state",
    label: "Active Memory session toggles",
    async detectLegacyState(params) {
      const filePath = resolveToggleStatePath(params.stateDir);
      const fast = await readLegacyToggleEntries(filePath, LEGACY_TOGGLE_STATE_MAX_BYTES);
      if (fast.oversized) {
        const recovery = await readLegacyToggleEntries(filePath, LEGACY_TOGGLE_RECOVERY_MAX_BYTES);
        if (recovery.oversized) {
          return {
            preview: [
              `- Active Memory session toggles: legacy source exceeds ${LEGACY_TOGGLE_RECOVERY_MAX_BYTES} bytes and cannot be recovered; left in place`,
            ],
          };
        }
        if (recovery.entries.length === 0) {
          return null;
        }
        return {
          preview: [previewForEntries(recovery.entries)],
        };
      }
      if (fast.entries.length === 0) {
        return null;
      }
      return {
        preview: [previewForEntries(fast.entries)],
      };
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const filePath = resolveToggleStatePath(params.stateDir);
      const fast = await readLegacyToggleEntries(filePath, LEGACY_TOGGLE_STATE_MAX_BYTES);
      if (fast.oversized) {
        const recovery = await readLegacyToggleEntries(filePath, LEGACY_TOGGLE_RECOVERY_MAX_BYTES);
        if (recovery.oversized) {
          warnings.push(
            `Skipped Active Memory session toggle migration because ${filePath} exceeds ${LEGACY_TOGGLE_RECOVERY_MAX_BYTES} bytes; left legacy source in place`,
          );
          return { changes, warnings };
        }
        if (recovery.entries.length === 0) {
          return { changes, warnings };
        }
        return await migrateToggleEntriesToPluginState({
          filePath,
          entries: recovery.entries,
          context: params.context,
        });
      }
      if (fast.entries.length === 0) {
        return { changes, warnings };
      }
      return await migrateToggleEntriesToPluginState({
        filePath,
        entries: fast.entries,
        context: params.context,
      });
    },
  },
];
