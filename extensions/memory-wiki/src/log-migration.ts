import fs from "node:fs/promises";
import path from "node:path";
import { type MemoryWikiLogEntry, writeMemoryWikiLogEntryForMigration } from "./log.js";

export function resolveMemoryWikiLegacyLogPath(vaultRoot: string): string {
  return path.join(vaultRoot, ".openclaw-wiki", "log.jsonl");
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
      await writeMemoryWikiLogEntryForMigration(params.vaultRoot, parsed, `legacy-${index + 1}`);
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
