import fs from "node:fs";
import path from "node:path";
import type { ChannelLegacyStateMigrationPlan } from "openclaw/plugin-sdk/channel-contract";
import { upsertPluginStateMigrationEntry } from "openclaw/plugin-sdk/migration-runtime";
import { normalizePersistedBinding } from "./monitor/thread-bindings.state.js";
import type { PersistedThreadBindingsPayload } from "./monitor/thread-bindings.types.js";

const DISCORD_PLUGIN_ID = "discord";

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function sanitizePreferenceEntry(value: unknown):
  | {
      recent: string[];
      updatedAt: string;
    }
  | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const recent = Array.isArray(record.recent)
    ? record.recent.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      )
    : [];
  return {
    recent,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
  };
}

function importModelPickerPreferences(sourcePath: string, env: NodeJS.ProcessEnv): number {
  const parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Discord model-picker preferences must contain an object");
  }
  const payload = parsed as Record<string, unknown>;
  if (payload.version !== 1 || !payload.entries || typeof payload.entries !== "object") {
    throw new Error("Discord model-picker preferences must be version 1");
  }
  let imported = 0;
  for (const [key, value] of Object.entries(payload.entries as Record<string, unknown>)) {
    const entry = sanitizePreferenceEntry(value);
    if (!key.trim() || !entry) {
      continue;
    }
    upsertPluginStateMigrationEntry({
      pluginId: DISCORD_PLUGIN_ID,
      namespace: "model-picker-preferences",
      key,
      value: entry,
      createdAt: Date.parse(entry.updatedAt) || Date.now(),
      env,
    });
    imported++;
  }
  fs.rmSync(sourcePath, { force: true });
  return imported;
}

function importCommandDeployHashes(sourcePath: string, env: NodeJS.ProcessEnv): number {
  const parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Discord command deploy cache must contain an object");
  }
  const hashes = (parsed as Record<string, unknown>).hashes;
  if (!hashes || typeof hashes !== "object" || Array.isArray(hashes)) {
    fs.rmSync(sourcePath, { force: true });
    return 0;
  }
  let imported = 0;
  const updatedAt =
    typeof (parsed as Record<string, unknown>).updatedAt === "string"
      ? ((parsed as Record<string, unknown>).updatedAt as string)
      : new Date().toISOString();
  for (const [key, hash] of Object.entries(hashes as Record<string, unknown>)) {
    if (!key.trim() || typeof hash !== "string" || !hash.trim()) {
      continue;
    }
    upsertPluginStateMigrationEntry({
      pluginId: DISCORD_PLUGIN_ID,
      namespace: "command-deploy-hashes",
      key: `legacy:${key}`,
      value: { hash, updatedAt },
      createdAt: Date.parse(updatedAt) || Date.now(),
      env,
    });
    imported++;
  }
  fs.rmSync(sourcePath, { force: true });
  return imported;
}

function importThreadBindings(sourcePath: string, env: NodeJS.ProcessEnv): number {
  const parsed = JSON.parse(
    fs.readFileSync(sourcePath, "utf8"),
  ) as Partial<PersistedThreadBindingsPayload>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Discord thread bindings must contain an object");
  }
  if (parsed.version !== 1 || !parsed.bindings || typeof parsed.bindings !== "object") {
    throw new Error("Discord thread bindings must be version 1");
  }
  let imported = 0;
  for (const [key, value] of Object.entries(parsed.bindings)) {
    const normalized = normalizePersistedBinding(key, value);
    if (!normalized) {
      continue;
    }
    upsertPluginStateMigrationEntry({
      pluginId: DISCORD_PLUGIN_ID,
      namespace: "thread-bindings",
      key,
      value: normalized,
      createdAt: normalized.boundAt || normalized.lastActivityAt || Date.now(),
      env,
    });
    imported++;
  }
  fs.rmSync(sourcePath, { force: true });
  return imported;
}

function discordPluginStatePlan(params: {
  label: string;
  sourcePath: string;
  namespace: "model-picker-preferences" | "command-deploy-hashes" | "thread-bindings";
  importSource: (sourcePath: string, env: NodeJS.ProcessEnv) => number;
}): ChannelLegacyStateMigrationPlan {
  return {
    kind: "custom",
    label: params.label,
    sourcePath: params.sourcePath,
    targetTable: `plugin_state_entries:${DISCORD_PLUGIN_ID}/${params.namespace}`,
    apply: ({ env }) => {
      const imported = params.importSource(params.sourcePath, env);
      return {
        changes: [
          `Imported ${imported} ${params.label} row(s) into SQLite plugin state (${DISCORD_PLUGIN_ID}/${params.namespace})`,
        ],
        warnings: [],
      };
    },
  };
}

export function detectDiscordLegacyStateMigrations(params: {
  stateDir: string;
}): ChannelLegacyStateMigrationPlan[] {
  const plans: ChannelLegacyStateMigrationPlan[] = [];
  const preferencesPath = path.join(params.stateDir, "discord", "model-picker-preferences.json");
  if (fileExists(preferencesPath)) {
    plans.push(
      discordPluginStatePlan({
        label: "Discord model-picker preferences",
        sourcePath: preferencesPath,
        namespace: "model-picker-preferences",
        importSource: importModelPickerPreferences,
      }),
    );
  }
  const commandDeployPath = path.join(params.stateDir, "discord", "command-deploy-cache.json");
  if (fileExists(commandDeployPath)) {
    plans.push(
      discordPluginStatePlan({
        label: "Discord command deploy hashes",
        sourcePath: commandDeployPath,
        namespace: "command-deploy-hashes",
        importSource: importCommandDeployHashes,
      }),
    );
  }
  const threadBindingsPath = path.join(params.stateDir, "discord", "thread-bindings.json");
  if (fileExists(threadBindingsPath)) {
    plans.push(
      discordPluginStatePlan({
        label: "Discord thread bindings",
        sourcePath: threadBindingsPath,
        namespace: "thread-bindings",
        importSource: importThreadBindings,
      }),
    );
  }
  return plans;
}
