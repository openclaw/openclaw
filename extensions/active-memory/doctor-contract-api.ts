/**
 * Doctor migration contract for Active Memory state. It moves legacy per-session
 * toggle JSON into the plugin state keyed store used by current runtimes.
 */
import crypto from "node:crypto";
import path from "node:path";
import {
  archiveLegacyStateSource,
  type PluginDoctorStateMigration,
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

type LegacyToggleReadResult =
  | { kind: "ok"; entries: ActiveMemoryToggleEntry[] }
  | { kind: "empty" }
  | { kind: "oversized"; warning: string };

function resolveToggleStatePath(stateDir: string): string {
  return path.join(stateDir, "plugins", "active-memory", TOGGLE_STATE_FILE);
}

function activeMemoryToggleKey(sessionKey: string): string {
  return crypto.createHash("sha256").update(sessionKey, "utf8").digest("hex");
}

function normalizeLegacyUpdatedAt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function isLegacyToggleStateOversizedError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.includes(`File exceeds ${LEGACY_TOGGLE_STATE_MAX_BYTES} bytes`)
  );
}

function oversizedLegacyToggleStateWarning(filePath: string): string {
  return `Skipped Active Memory session toggle migration because ${filePath} exceeds ${LEGACY_TOGGLE_STATE_MAX_BYTES} bytes; left legacy source in place`;
}

async function readLegacyToggleState(filePath: string): Promise<LegacyToggleReadResult> {
  try {
    const parsed = JSON.parse(
      (
        await readRegularFile({
          filePath,
          maxBytes: LEGACY_TOGGLE_STATE_MAX_BYTES,
        })
      ).buffer.toString("utf8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return { kind: "empty" };
    }
    const sessions = (parsed as { sessions?: unknown }).sessions;
    if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) {
      return { kind: "empty" };
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
    return entries.length > 0 ? { kind: "ok", entries } : { kind: "empty" };
  } catch (err) {
    if (isLegacyToggleStateOversizedError(err)) {
      return { kind: "oversized", warning: oversizedLegacyToggleStateWarning(filePath) };
    }
    return { kind: "empty" };
  }
}

/** State migrations exposed to OpenClaw doctor for Active Memory. */
export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "active-memory-session-toggles-json-to-plugin-state",
    label: "Active Memory session toggles",
    async detectLegacyState(params) {
      const filePath = resolveToggleStatePath(params.stateDir);
      const legacyState = await readLegacyToggleState(filePath);
      if (legacyState.kind === "oversized") {
        return {
          preview: [`- ${legacyState.warning}`],
        };
      }
      if (legacyState.kind === "empty") {
        return null;
      }
      return {
        preview: [
          `- Active Memory session toggles: ${legacyState.entries.length} ${legacyState.entries.length === 1 ? "entry" : "entries"} -> plugin state (${SESSION_TOGGLES_NAMESPACE})`,
        ],
      };
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const filePath = resolveToggleStatePath(params.stateDir);
      const legacyState = await readLegacyToggleState(filePath);
      if (legacyState.kind === "oversized") {
        warnings.push(legacyState.warning);
        return { changes, warnings };
      }
      if (legacyState.kind === "empty") {
        return { changes, warnings };
      }
      const entries = legacyState.entries;
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
