import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import type { PackManifest } from "../../pack-loader/index.js";
import type { NexusPackageDetail, NexusPackageSummary } from "./types.js";

export type CatalogPackEntry = {
  slug: string;
  dir: string;
  manifest: PackManifest;
};

export async function readPackManifestFile(manifestPath: string): Promise<PackManifest> {
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as PackManifest;
  if (!raw?.id || !raw?.version) {
    throw new Error(`Invalid pack manifest: ${manifestPath}`);
  }
  return raw;
}

/** Scan catalog root: each subdir with claworks.pack.json is a pack (version from manifest). */
export async function scanNexusCatalog(catalogRoot: string): Promise<CatalogPackEntry[]> {
  const entries: CatalogPackEntry[] = [];
  let dirs: string[];
  try {
    dirs = await readdir(catalogRoot);
  } catch {
    return entries;
  }

  for (const slug of dirs) {
    if (slug.startsWith(".")) {
      continue;
    }
    const dir = join(catalogRoot, slug);
    const manifestPath = join(dir, "claworks.pack.json");
    try {
      const st = await stat(manifestPath);
      if (!st.isFile()) {
        continue;
      }
      const manifest = await readPackManifestFile(manifestPath);
      entries.push({ slug: manifest.id || slug, dir, manifest });
    } catch {
      // skip non-pack dirs
    }
  }
  return entries;
}

export function listPackages(
  entries: CatalogPackEntry[],
  opts?: { family?: string; q?: string },
): NexusPackageSummary[] {
  const q = opts?.q?.toLowerCase().trim();
  return entries
    .filter((e) => {
      if (opts?.family && opts.family !== "claworks-pack") {
        return false;
      }
      if (!q) {
        return true;
      }
      return (
        e.slug.toLowerCase().includes(q) ||
        e.manifest.name.toLowerCase().includes(q) ||
        (e.manifest.description?.toLowerCase().includes(q) ?? false)
      );
    })
    .map((e) => ({
      slug: e.slug,
      name: e.manifest.name,
      description: e.manifest.description,
      latestVersion: e.manifest.version,
      family: "claworks-pack",
    }));
}

export function getPackageDetail(
  entries: CatalogPackEntry[],
  slug: string,
): NexusPackageDetail | null {
  const matches = entries.filter((e) => e.slug === slug);
  if (matches.length === 0) {
    return null;
  }
  const first = matches[0]!;
  return {
    slug,
    name: first.manifest.name,
    description: first.manifest.description,
    latestVersion: first.manifest.version,
    family: "claworks-pack",
    versions: [...new Set(matches.map((m) => m.manifest.version))],
  };
}

export function resolvePackDir(
  entries: CatalogPackEntry[],
  slug: string,
  version?: string,
): CatalogPackEntry | null {
  const matches = entries.filter((e) => e.slug === slug);
  if (matches.length === 0) {
    return null;
  }
  if (version) {
    return matches.find((m) => m.manifest.version === version) ?? null;
  }
  return (
    matches.toSorted((a, b) => b.manifest.version.localeCompare(a.manifest.version))[0] ?? null
  );
}

export function openPackArtifactStream(packDir: string) {
  return tar.c({ gzip: true, cwd: packDir }, ["."]);
}

export async function extractPackBuffer(buffer: Buffer, destDir: string): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "claworks-pack-"));
  const archive = join(tempDir, "pack.tgz");
  try {
    await writeFile(archive, buffer);
    await tar.x({ file: archive, cwd: destDir, gzip: true });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
