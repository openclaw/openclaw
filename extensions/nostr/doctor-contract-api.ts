// Nostr API module exposes the plugin public contract.
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  archiveLegacyStateSource,
  type PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { asFiniteNumber } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeNostrStateAccountId } from "./src/state-account-id.js";

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
    lastProcessedAt: asFiniteNumber(parsed.lastProcessedAt) ?? null,
    gatewayStartedAt: asFiniteNumber(parsed.gatewayStartedAt) ?? null,
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
    lastPublishedAt: asFiniteNumber(parsed.lastPublishedAt) ?? null,
    lastPublishedEventId:
      typeof parsed.lastPublishedEventId === "string" ? parsed.lastPublishedEventId : null,
    lastPublishResults:
      rawResults === null || Object.keys(lastPublishResults).length === 0
        ? null
        : lastPublishResults,
  };
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
}

async function listLegacyFiles<T>(params: {
  stateDir: string;
  prefix: string;
  parse: (value: unknown) => T | null;
}): Promise<Array<{ accountId: string; filePath: string; value: T }>> {
  const dir = path.join(params.stateDir, "nostr");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const suffix = ".json";
  const files: Array<{ accountId: string; filePath: string; value: T }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(params.prefix) || !entry.name.endsWith(suffix)) {
      continue;
    }
    const rawAccountId = entry.name.slice(params.prefix.length, -suffix.length);
    const accountId = normalizeNostrStateAccountId(rawAccountId);
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

async function ensureStoreCapacity(params: {
  files: Array<{ accountId: string }>;
  store: { entries: () => Promise<Array<{ key: string; value: unknown }>> };
  maxEntries: number;
  label: string;
  warnings: string[];
}): Promise<Set<string> | null> {
  const existingKeys = new Set((await params.store.entries()).map((entry) => entry.key));
  const missingKeys = new Set(
    params.files.map((file) => file.accountId).filter((key) => !existingKeys.has(key)),
  );
  if (missingKeys.size > params.maxEntries - existingKeys.size) {
    params.warnings.push(
      `Skipped migrating ${params.label} because plugin state has room for ${params.maxEntries - existingKeys.size} of ${missingKeys.size} missing entries; left legacy sources in place`,
    );
    return null;
  }
  return existingKeys;
}

function createNostrStateMigration(options: {
  namespace: string;
  label: string;
  parse: (value: unknown) => unknown;
}): PluginDoctorStateMigration {
  return {
    id: `nostr-${options.namespace}-json-to-plugin-state`,
    label: options.label,
    async detectLegacyState(params) {
      const files = await listLegacyFiles({
        stateDir: params.stateDir,
        prefix: `${options.namespace}-`,
        parse: options.parse,
      });
      if (files.length === 0) {
        return null;
      }
      return {
        preview: [
          `- ${options.label}: ${files.length} ${files.length === 1 ? "account" : "accounts"} -> plugin state (${options.namespace})`,
        ],
      };
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const files = await listLegacyFiles({
        stateDir: params.stateDir,
        prefix: `${options.namespace}-`,
        parse: options.parse,
      });
      const store = params.context.openPluginStateKeyedStore<unknown>({
        namespace: options.namespace,
        maxEntries: MAX_NOSTR_STATE_ENTRIES,
      });
      const existingKeys = await ensureStoreCapacity({
        files,
        store,
        maxEntries: MAX_NOSTR_STATE_ENTRIES,
        label: options.label,
        warnings,
      });
      if (!existingKeys) {
        return { changes, warnings };
      }
      let imported = 0;
      for (const file of files) {
        if (!existingKeys.has(file.accountId)) {
          await store.register(file.accountId, file.value);
          existingKeys.add(file.accountId);
          imported++;
        }
        await archiveLegacyStateSource({
          filePath: file.filePath,
          label: options.label,
          changes,
          warnings,
        });
      }
      if (imported > 0) {
        changes.unshift(
          `Migrated ${imported} Nostr ${options.namespace} ${imported === 1 ? "entry" : "entries"} -> plugin state`,
        );
      }
      return { changes, warnings };
    },
  };
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  createNostrStateMigration({
    namespace: BUS_STATE_NAMESPACE,
    label: "Nostr bus state",
    parse: parseBusState,
  }),
  createNostrStateMigration({
    namespace: PROFILE_STATE_NAMESPACE,
    label: "Nostr profile state",
    parse: parseProfileState,
  }),
];
