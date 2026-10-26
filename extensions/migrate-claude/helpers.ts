import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  markMigrationItemError,
  markMigrationItemSkipped,
  MIGRATION_REASON_MISSING_SOURCE_OR_TARGET,
} from "openclaw/plugin-sdk/migration";
import { safeStat } from "openclaw/plugin-sdk/path-existence-runtime";
import type { MigrationItem } from "openclaw/plugin-sdk/plugin-entry";
import { decodeUtf8Input } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import {
  appendRegularFile,
  pathExists,
  readRegularFile,
} from "openclaw/plugin-sdk/security-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export function resolveHomePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  return path.resolve(trimmed.replace(/^~(?=$|[\\/])/u, () => os.homedir()));
}

export { pathExists as exists };

export async function isDirectory(dirPath: string): Promise<boolean> {
  return (await safeStat(dirPath))?.isDirectory() === true;
}

export function sanitizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

export async function readJsonObject(
  filePath: string | undefined,
): Promise<Record<string, unknown>> {
  const opened = filePath
    ? await fs
        .realpath(filePath)
        .then((resolvedPath) => readRegularFile({ filePath: resolvedPath }))
        .catch(() => undefined)
    : undefined;
  if (!opened) {
    return {};
  }
  // Encoding errors must not become an optional JSON parse fallback.
  const content = decodeUtf8Input(
    opened.buffer,
    `Claude configuration file ${filePath} (re-save or re-encode it as UTF-8, then rerun the migration)`,
  );
  try {
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function appendItem(item: MigrationItem): Promise<MigrationItem> {
  if (!item.source || !item.target) {
    return markMigrationItemError(item, MIGRATION_REASON_MISSING_SOURCE_OR_TARGET);
  }
  try {
    const { buffer } = await readRegularFile({ filePath: await fs.realpath(item.source) });
    const content = decodeUtf8Input(
      buffer,
      `Claude instruction file ${item.source} (re-save or re-encode it as UTF-8, then rerun the migration)`,
    );
    const label =
      typeof item.details?.sourceLabel === "string"
        ? item.details.sourceLabel
        : path.basename(item.source);
    const body = content.trimEnd();
    if (!body) {
      return markMigrationItemSkipped(item, "source file is empty");
    }
    const importBlock = `\n\n<!-- Imported from Claude: ${label} -->\n\n${body}\n`;
    const existing = (await pathExists(item.target))
      ? (await readRegularFile({ filePath: item.target })).buffer.toString("utf8")
      : "";
    if (existing.includes(importBlock)) {
      return markMigrationItemSkipped(item, "already imported from Claude");
    }
    await fs.mkdir(path.dirname(item.target), { recursive: true });
    await appendRegularFile({
      filePath: item.target,
      content: importBlock,
      rejectSymlinkParents: true,
    });
    return { ...item, status: "migrated" };
  } catch (err) {
    return markMigrationItemError(item, err instanceof Error ? err.message : String(err));
  }
}
