import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export const LEGACY_MEMORY_SIDECAR_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

export async function collectArchivedLegacyReindexFiles(params: {
  legacyDir: string;
  configuredPaths: string[];
}): Promise<string[]> {
  const stat = async (file: string, followSymlinks = false) =>
    (followSymlinks ? fs.stat(file) : fs.lstat(file)).catch((err: unknown) =>
      asOptionalObjectRecord(err)?.code === "ENOENT" ? undefined : null,
    );
  const configuredSources = await Promise.all(
    params.configuredPaths.map((file) => stat(file, true)),
  );
  if (configuredSources.includes(null)) {
    return [];
  }
  const { legacyDir } = params;
  // Unreadable optional cleanup state is retained, never a reason to fail an update.
  const entries = await fs.readdir(legacyDir).catch(() => []);
  const bases = new Set(
    entries
      .filter((name) => name.endsWith(".sqlite.migrated"))
      .map((name) => path.join(legacyDir, name.slice(0, -".migrated".length))),
  );
  for (const configured of params.configuredPaths) {
    bases.add(configured);
  }
  const files: string[] = [];
  for (const base of bases) {
    // Only successful archival establishes retirement. A missing primary alone
    // can be an interrupted swap; any surviving primary/companion keeps recovery intact.
    if (!(await stat(`${base}.migrated`))?.isFile()) {
      continue;
    }
    if (
      (await Promise.all(LEGACY_MEMORY_SIDECAR_SUFFIXES.map((s) => stat(`${base}${s}`)))).some(
        (s) => s !== undefined,
      )
    ) {
      continue;
    }
    const prefix = `${path.basename(base)}.tmp-`;
    const families = new Set<string>();
    for (const entry of (await fs.readdir(path.dirname(base)).catch(() => [])).filter((name) =>
      name.startsWith(prefix),
    )) {
      const match =
        /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-(?:wal|shm|journal))?$/.exec(
          entry.slice(prefix.length),
        );
      if (match) {
        families.add(path.join(path.dirname(base), `${prefix}${match[1]}`));
      }
    }
    for (const family of families) {
      const members = LEGACY_MEMORY_SIDECAR_SUFFIXES.map((s) => `${family}${s}`);
      const stats = await Promise.all(members.map((file) => stat(file)));
      // A configured import source remains owned, including aliases to a shadow.
      if (
        stats.some(
          (member) =>
            member &&
            configuredSources.some(
              (source) => source && source.dev === member.dev && source.ino === member.ino,
            ),
        )
      ) {
        continue;
      }
      // A young or non-regular companion protects the whole family, including symlinks.
      if (
        stats.every(
          (s) => s !== null && (!s || (s.isFile() && Date.now() - s.mtimeMs >= 24 * 60 * 60_000)),
        )
      ) {
        files.push(...members.filter((_, index) => stats[index]));
      }
    }
  }
  return files;
}
