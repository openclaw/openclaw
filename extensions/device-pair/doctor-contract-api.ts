import { statSync } from "node:fs";
// Device Pair doctor contract migrates shipped plugin-owned state.
import fs from "node:fs/promises";
import path from "node:path";
import {
  archiveLegacyStateSource,
  type PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor";
import {
  DEVICE_PAIR_NOTIFY_LEGACY_STATE_FILE,
  DEVICE_PAIR_NOTIFY_SUBSCRIBER_MAX_ENTRIES,
  DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE,
  normalizeLegacyNotifyState,
  notifySubscriberStoreKey,
  type LegacyNotifyStateFile,
  type NotifySubscription,
} from "./notify-state.js";

function resolveLegacyNotifyStatePath(stateDir: string): string {
  return path.join(stateDir, DEVICE_PAIR_NOTIFY_LEGACY_STATE_FILE);
}

// Legacy notify state is a small JSON file — cap at 10 MiB.
const MAX_LEGACY_NOTIFY_FILE_BYTES = 10 * 1024 * 1024;

async function readLegacyNotifyFileSafely(filePath: string): Promise<string> {
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`not a regular file: ${filePath}`);
  }
  if (stat.size > MAX_LEGACY_NOTIFY_FILE_BYTES) {
    throw new Error(
      `file too large: ${stat.size} bytes exceeds ${MAX_LEGACY_NOTIFY_FILE_BYTES} bytes: ${filePath}`,
    );
  }
  return await fs.readFile(filePath, "utf8");
}

async function readLegacyNotifyState(filePath: string): Promise<LegacyNotifyStateFile | null> {
  try {
    return normalizeLegacyNotifyState(
      JSON.parse(await readLegacyNotifyFileSafely(filePath)) as unknown,
    );
  } catch {
    return null;
  }
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "device-pair-notify-json-to-plugin-state",
    label: "Device Pair notify subscribers",
    async detectLegacyState(params) {
      const filePath = resolveLegacyNotifyStatePath(params.stateDir);
      const state = await readLegacyNotifyState(filePath);
      if (!state || state.subscribers.length === 0) {
        return null;
      }
      return {
        preview: [
          `- Device Pair notify subscribers: ${filePath} -> plugin state (${DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE}, ${state.subscribers.length} subscriber(s))`,
        ],
      };
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const filePath = resolveLegacyNotifyStatePath(params.stateDir);
      const state = await readLegacyNotifyState(filePath);
      if (!state || state.subscribers.length === 0) {
        return { changes, warnings };
      }

      const store = params.context.openPluginStateKeyedStore<NotifySubscription>({
        namespace: DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE,
        maxEntries: DEVICE_PAIR_NOTIFY_SUBSCRIBER_MAX_ENTRIES,
      });
      let imported = 0;
      let alreadyPresent = 0;
      for (const subscriber of state.subscribers) {
        const inserted = await store.registerIfAbsent(
          notifySubscriberStoreKey(subscriber),
          subscriber,
        );
        if (inserted) {
          imported++;
        } else {
          alreadyPresent++;
        }
      }

      changes.push(
        `Migrated Device Pair notify subscribers -> plugin state (${imported} imported, ${alreadyPresent} already present)`,
      );
      await archiveLegacyStateSource({
        filePath,
        label: "Device Pair notify-state",
        changes,
        warnings,
      });
      return { changes, warnings };
    },
  },
];
