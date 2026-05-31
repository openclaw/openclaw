import fs from "node:fs/promises";
import path from "node:path";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor";

type NostrBusState = {
  version: 2;
  lastProcessedAt: number | null;
  gatewayStartedAt: number | null;
  recentEventIds: string[];
};

type NostrProfileState = {
  version: 1;
  lastPublishedAt: number | null;
  lastPublishedEventId: string | null;
  lastPublishResults: Record<string, "ok" | "failed" | "timeout"> | null;
};

const BUS_STATE_NAMESPACE = "bus-state";
const PROFILE_STATE_NAMESPACE = "profile-state";
const MAX_NOSTR_STATE_ENTRIES = 256;

function normalizeAccountId(accountId?: string): string {
  const trimmed = accountId?.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseBusState(value: unknown): NostrBusState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const parsed = value as Record<string, unknown>;
  if (parsed.version !== 1 && parsed.version !== 2) {
    return null;
  }
  return {
    version: 2,
    lastProcessedAt: finiteNumberOrNull(parsed.lastProcessedAt),
    gatewayStartedAt: finiteNumberOrNull(parsed.gatewayStartedAt),
    recentEventIds:
      parsed.version === 2 && Array.isArray(parsed.recentEventIds)
        ? parsed.recentEventIds.filter((entry): entry is string => typeof entry === "string")
        : [],
  };
}

function parseProfileState(value: unknown): NostrProfileState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const parsed = value as Record<string, unknown>;
  if (parsed.version !== 1) {
    return null;
  }
  const rawResults = parsed.lastPublishResults;
  const lastPublishResults: Record<string, "ok" | "failed" | "timeout"> = {};
  if (rawResults && typeof rawResults === "object" && !Array.isArray(rawResults)) {
    for (const [relay, result] of Object.entries(rawResults)) {
      if (result === "ok" || result === "failed" || result === "timeout") {
        lastPublishResults[relay] = result;
      }
    }
  }
  return {
    version: 1,
    lastPublishedAt: finiteNumberOrNull(parsed.lastPublishedAt),
    lastPublishedEventId:
      typeof parsed.lastPublishedEventId === "string" ? parsed.lastPublishedEventId : null,
    lastPublishResults:
      rawResults === null || Object.keys(lastPublishResults).length === 0
        ? null
        : lastPublishResults,
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
}

async function listLegacyFiles(params: {
  stateDir: string;
  prefix: string;
  parse: (value: unknown) => unknown | null;
}): Promise<Array<{ accountId: string; filePath: string; value: unknown }>> {
  const dir = path.join(params.stateDir, "nostr");
  let entries: fs.Dirent[] = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const suffix = ".json";
  const files: Array<{ accountId: string; filePath: string; value: unknown }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(params.prefix) || !entry.name.endsWith(suffix)) {
      continue;
    }
    const rawAccountId = entry.name.slice(params.prefix.length, -suffix.length);
    const accountId = normalizeAccountId(rawAccountId);
    const filePath = path.join(dir, entry.name);
    try {
      const value = params.parse(await readJsonFile(filePath));
      if (value) {
        files.push({ accountId, filePath, value });
      }
    } catch {
      // Malformed legacy cache/cursor files are ignored by migration.
    }
  }
  return files;
}

async function archiveLegacySource(params: {
  filePath: string;
  label: string;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const archivedPath = `${params.filePath}.migrated`;
  if (await fileExists(archivedPath)) {
    params.warnings.push(
      `Left migrated ${params.label} source in place because ${archivedPath} already exists`,
    );
    return;
  }
  try {
    await fs.rename(params.filePath, archivedPath);
    params.changes.push(`Archived ${params.label} legacy source -> ${archivedPath}`);
  } catch (err) {
    params.warnings.push(`Failed archiving ${params.label} legacy source: ${String(err)}`);
  }
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "nostr-bus-state-json-to-plugin-state",
    label: "Nostr bus state",
    async detectLegacyState(params) {
      const files = await listLegacyFiles({
        stateDir: params.stateDir,
        prefix: "bus-state-",
        parse: parseBusState,
      });
      if (files.length === 0) {
        return null;
      }
      return {
        preview: [
          `- Nostr bus state: ${files.length} ${files.length === 1 ? "account" : "accounts"} -> plugin state (${BUS_STATE_NAMESPACE})`,
        ],
      };
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const files = await listLegacyFiles({
        stateDir: params.stateDir,
        prefix: "bus-state-",
        parse: parseBusState,
      });
      const store = params.context.openPluginStateKeyedStore<NostrBusState>({
        namespace: BUS_STATE_NAMESPACE,
        maxEntries: MAX_NOSTR_STATE_ENTRIES,
      });
      let imported = 0;
      for (const file of files) {
        if (!(await store.lookup(file.accountId))) {
          await store.register(file.accountId, file.value as NostrBusState);
          imported++;
        }
        await archiveLegacySource({
          filePath: file.filePath,
          label: "Nostr bus state",
          changes,
          warnings,
        });
      }
      if (imported > 0) {
        changes.unshift(
          `Migrated ${imported} Nostr bus-state ${imported === 1 ? "entry" : "entries"} -> plugin state`,
        );
      }
      return { changes, warnings };
    },
  },
  {
    id: "nostr-profile-state-json-to-plugin-state",
    label: "Nostr profile state",
    async detectLegacyState(params) {
      const files = await listLegacyFiles({
        stateDir: params.stateDir,
        prefix: "profile-state-",
        parse: parseProfileState,
      });
      if (files.length === 0) {
        return null;
      }
      return {
        preview: [
          `- Nostr profile state: ${files.length} ${files.length === 1 ? "account" : "accounts"} -> plugin state (${PROFILE_STATE_NAMESPACE})`,
        ],
      };
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const files = await listLegacyFiles({
        stateDir: params.stateDir,
        prefix: "profile-state-",
        parse: parseProfileState,
      });
      const store = params.context.openPluginStateKeyedStore<NostrProfileState>({
        namespace: PROFILE_STATE_NAMESPACE,
        maxEntries: MAX_NOSTR_STATE_ENTRIES,
      });
      let imported = 0;
      for (const file of files) {
        if (!(await store.lookup(file.accountId))) {
          await store.register(file.accountId, file.value as NostrProfileState);
          imported++;
        }
        await archiveLegacySource({
          filePath: file.filePath,
          label: "Nostr profile state",
          changes,
          warnings,
        });
      }
      if (imported > 0) {
        changes.unshift(
          `Migrated ${imported} Nostr profile-state ${imported === 1 ? "entry" : "entries"} -> plugin state`,
        );
      }
      return { changes, warnings };
    },
  },
];
