import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
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

export function resolveMemoryWikiLegacyLogPath(vaultRoot: string): string {
  return path.join(vaultRoot, ".openclaw-wiki", "log.jsonl");
}

export async function appendMemoryWikiLog(
  vaultRoot: string,
  entry: MemoryWikiLogEntry,
): Promise<void> {
  await logStore.register(resolveLogKey(vaultRoot, entry), {
    vaultHash: resolveVaultHash(vaultRoot),
    ...entry,
  });
}

function isMemoryWikiLogEntry(value: unknown): value is MemoryWikiLogEntry {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { type?: unknown }).type === "string" &&
    typeof (value as { timestamp?: unknown }).timestamp === "string"
  );
}

export async function importMemoryWikiLegacyLog(params: {
  vaultRoot: string;
}): Promise<{ imported: number; warnings: string[]; sourcePath: string }> {
  const sourcePath = resolveMemoryWikiLegacyLogPath(params.vaultRoot);
  const warnings: string[] = [];
  let imported = 0;
  const rawText = await fs.readFile(sourcePath, "utf8");
  for (const [index, line] of rawText.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isMemoryWikiLogEntry(parsed)) {
        warnings.push(`Skipped invalid Memory Wiki log entry at ${sourcePath}:${index + 1}`);
        continue;
      }
      await logStore.register(resolveLogKey(params.vaultRoot, parsed, `legacy-${index + 1}`), {
        vaultHash: resolveVaultHash(params.vaultRoot),
        ...parsed,
      });
      imported++;
    } catch (error) {
      warnings.push(
        `Failed reading Memory Wiki log entry at ${sourcePath}:${index + 1}: ${String(error)}`,
      );
    }
  }
  if (warnings.length === 0) {
    await fs.rm(sourcePath, { force: true });
  }
  return { imported, warnings, sourcePath };
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
