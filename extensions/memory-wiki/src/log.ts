import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { createPluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

export type MemoryWikiLogEntry = {
  type: "init" | "ingest" | "compile" | "lint";
  timestamp: string;
  details?: Record<string, unknown>;
};

type PersistedMemoryWikiLogEntry = MemoryWikiLogEntry & {
  vaultHash: string;
};

const logStore = createPluginStateKeyedStore<PersistedMemoryWikiLogEntry>("memory-wiki", {
  namespace: "activity-log",
  maxEntries: 100_000,
});

function hashSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function resolveVaultHash(vaultRoot: string): string {
  return hashSegment(path.resolve(vaultRoot));
}

function resolveLogKey(
  vaultRoot: string,
  entry: MemoryWikiLogEntry,
  suffix: string = randomUUID(),
): string {
  return `${resolveVaultHash(vaultRoot)}:${entry.timestamp}:${suffix}`;
}

export async function writeMemoryWikiLogEntryForMigration(
  vaultRoot: string,
  entry: MemoryWikiLogEntry,
  suffix: string,
): Promise<void> {
  await logStore.register(resolveLogKey(vaultRoot, entry, suffix), {
    vaultHash: resolveVaultHash(vaultRoot),
    ...entry,
  });
}

export async function appendMemoryWikiLog(
  vaultRoot: string,
  entry: MemoryWikiLogEntry,
): Promise<void> {
  await writeMemoryWikiLogEntryForMigration(vaultRoot, entry, randomUUID());
}

export async function readMemoryWikiLogEntries(vaultRoot: string): Promise<MemoryWikiLogEntry[]> {
  const vaultHash = resolveVaultHash(vaultRoot);
  return (await logStore.entries())
    .filter((entry) => entry.value.vaultHash === vaultHash)
    .map((entry) => {
      const { vaultHash: _vaultHash, ...value } = entry.value;
      return value;
    });
}
