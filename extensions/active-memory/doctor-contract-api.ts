/**
 * Doctor migration contract for Active Memory state. It moves legacy per-session
 * toggle JSON into the plugin state keyed store used by current runtimes.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  archiveLegacyStateSource,
  type PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor";

type ActiveMemoryToggleEntry = {
  sessionKey: string;
  disabled: boolean;
  updatedAt: number;
};

const TOGGLE_STATE_FILE = "session-toggles.json";
const SESSION_TOGGLES_NAMESPACE = "session-toggles";
const MAX_TOGGLE_ENTRIES = 10_000;

function resolveToggleStatePath(stateDir: string): string {
  return path.join(stateDir, "plugins", "active-memory", TOGGLE_STATE_FILE);
}

function activeMemoryToggleKey(sessionKey: string): string {
  return crypto.createHash("sha256").update(sessionKey, "utf8").digest("hex");
}

function normalizeLegacyUpdatedAt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

// Legacy toggle state is a single-session JSON file — cap at 10 MiB.
export const MAX_LEGACY_TOGGLE_FILE_BYTES = 10 * 1024 * 1024;

async function readLegacyFileSafely(filePath: string): Promise<string> {
  const file = await fs.open(filePath, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) {
      throw new Error(`not a regular file: ${filePath}`);
    }
    if (stat.size > MAX_LEGACY_TOGGLE_FILE_BYTES) {
      throw new Error(
        `file too large: ${stat.size} bytes exceeds ${MAX_LEGACY_TOGGLE_FILE_BYTES} bytes: ${filePath}`,
      );
    }
    // Bind the descriptor read to the validated size so a concurrent writer
    // cannot grow the file after validation and exceed the migration cap. If
    // the file shrinks after validation, fail closed rather than migrating a
    // silent partial read.
    const size = stat.size;
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await file.read(buffer, offset, size - offset, offset);
      if (bytesRead === 0) {
        throw new Error(`file shrank during read: ${filePath}`);
      }
      offset += bytesRead;
    }
    return buffer.toString("utf8");
  } finally {
    await file.close();
  }
}

async function archiveOversizedLegacySource(params: {
  filePath: string;
  label: string;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const archivedPath = `${params.filePath}.migrated`;
  try {
    await fs.rename(params.filePath, archivedPath);
    params.changes.push(`Archived oversized ${params.label} legacy source -> ${archivedPath}`);
  } catch (error) {
    params.warnings.push(
      `Failed archiving oversized ${params.label} legacy source: ${String(error)}; left source in place`,
    );
  }
}

async function readLegacyToggleEntries(
  filePath: string,
  warnings: string[],
): Promise<ActiveMemoryToggleEntry[]> {
  try {
    const parsed = JSON.parse(await readLegacyFileSafely(filePath)) as unknown;
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
  } catch (err) {
    // ENOENT and invalid JSON are expected when there is no legacy state.
    // Oversized files are reported as a warning so the user knows their
    // existing state was not migrated.
    if (err instanceof Error && err.message.includes("file too large")) {
      warnings.push(err.message);
    }
    return [];
  }
}

async function readAndMaybeArchiveLegacyToggleEntries(
  filePath: string,
  changes: string[],
  warnings: string[],
): Promise<ActiveMemoryToggleEntry[]> {
  const entries = await readLegacyToggleEntries(filePath, warnings);
  if (entries.length === 0 && warnings.some((w) => w.includes("file too large"))) {
    await archiveOversizedLegacySource({
      filePath,
      label: "Active Memory session toggles",
      changes,
      warnings,
    });
  }
  return entries;
}

/** State migrations exposed to OpenClaw doctor for Active Memory. */
export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "active-memory-session-toggles-json-to-plugin-state",
    label: "Active Memory session toggles",
    async detectLegacyState(params) {
      const filePath = resolveToggleStatePath(params.stateDir);
      const warnings: string[] = [];
      const entries = await readLegacyToggleEntries(filePath, warnings);
      if (entries.length === 0) {
        if (warnings.length > 0) {
          return { preview: warnings };
        }
        return null;
      }
      return {
        preview: [
          `- Active Memory session toggles: ${entries.length} ${entries.length === 1 ? "entry" : "entries"} -> plugin state (${SESSION_TOGGLES_NAMESPACE})`,
        ],
      };
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const filePath = resolveToggleStatePath(params.stateDir);
      const entries = await readAndMaybeArchiveLegacyToggleEntries(filePath, changes, warnings);
      if (entries.length === 0) {
        return { changes, warnings };
      }
      const store = params.context.openPluginStateKeyedStore<ActiveMemoryToggleEntry>({
        namespace: SESSION_TOGGLES_NAMESPACE,
        maxEntries: MAX_TOGGLE_ENTRIES,
      });
      const existingKeys = new Set((await store.entries()).map((entry) => entry.key));
      const missingEntries = entries.filter(
        (entry) => !existingKeys.has(activeMemoryToggleKey(entry.sessionKey)),
      );
      if (missingEntries.length > MAX_TOGGLE_ENTRIES - existingKeys.size) {
        warnings.push(
          `Skipped Active Memory session toggle migration because plugin state has room for ${MAX_TOGGLE_ENTRIES - existingKeys.size} of ${missingEntries.length} missing entries; left legacy source in place`,
        );
        return { changes, warnings };
      }
      let imported = 0;
      for (const entry of entries) {
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
        filePath,
        label: "Active Memory session toggles",
        changes,
        warnings,
      });
      return { changes, warnings };
    },
  },
];
