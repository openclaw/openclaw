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
  const file = await fs.open(filePath, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) {
      throw new Error(`not a regular file: ${filePath}`);
    }
    if (stat.size > MAX_LEGACY_NOTIFY_FILE_BYTES) {
      throw new Error(
        `file too large: ${stat.size} bytes exceeds ${MAX_LEGACY_NOTIFY_FILE_BYTES} bytes: ${filePath}`,
      );
    }
    // Bind the descriptor read to the validated size so a concurrent writer
    // cannot grow the file after validation and exceed the migration cap.
    const size = stat.size;
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await file.read(buffer, offset, size - offset, offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    return buffer.toString("utf8", 0, offset);
  } finally {
    await file.close();
  }
}

async function readLegacyNotifyState(
  filePath: string,
  warnings: string[],
): Promise<LegacyNotifyStateFile | null> {
  try {
    return normalizeLegacyNotifyState(
      JSON.parse(await readLegacyNotifyFileSafely(filePath)) as unknown,
    );
  } catch (err) {
    // ENOENT is expected when there is no legacy state to migrate.
    // Oversized files are reported as a warning so the user knows their
    // existing state was not migrated.
    if (err instanceof Error && err.message.includes("file too large")) {
      warnings.push(err.message);
    }
    return null;
  }
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "device-pair-notify-json-to-plugin-state",
    label: "Device Pair notify subscribers",
    async detectLegacyState(params) {
      const filePath = resolveLegacyNotifyStatePath(params.stateDir);
      const warnings: string[] = [];
      const state = await readLegacyNotifyState(filePath, warnings);
      if (!state || state.subscribers.length === 0) {
        if (warnings.length > 0) {
          return { preview: warnings };
        }
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
      const state = await readLegacyNotifyState(filePath, warnings);
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
