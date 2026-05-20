import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PackLoader, CwPackConfig, LoadedPack } from "./types.js";
import { parseObjectTypeYaml, parsePlaybookYaml, readPackManifest } from "./yaml-parsers.js";

async function listYamlFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".yaml"))
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

async function loadPackFromDir(packDir: string): Promise<LoadedPack> {
  const manifestPath = join(packDir, "claworks.pack.json");
  const manifest = await readPackManifest(manifestPath);
  const ontologyDir = join(packDir, "ontology");

  const objectTypes = [];
  for (const file of await listYamlFiles(join(ontologyDir, "object_types"))) {
    const content = await readFile(file, "utf8");
    objectTypes.push(parseObjectTypeYaml(content, manifest.id, file));
  }

  const playbooks = [];
  for (const file of await listYamlFiles(join(ontologyDir, "playbooks"))) {
    const content = await readFile(file, "utf8");
    playbooks.push(parsePlaybookYaml(content, manifest.id));
  }

  return { manifest, path: packDir, objectTypes, playbooks };
}

export async function resolvePackDir(
  packRef: string,
  searchPaths: string[],
): Promise<string | null> {
  for (const base of searchPaths) {
    const candidate = join(base, packRef);
    try {
      const s = await stat(join(candidate, "claworks.pack.json"));
      if (s.isFile()) {
        return candidate;
      }
    } catch {
      // try next
    }
  }
  return null;
}

export function createPackLoader(): PackLoader {
  const loaded: LoadedPack[] = [];

  return {
    async load(packPath: string): Promise<LoadedPack> {
      const pack = await loadPackFromDir(packPath);
      const existing = loaded.findIndex((p) => p.manifest.id === pack.manifest.id);
      if (existing >= 0) {
        loaded[existing] = pack;
      } else {
        loaded.push(pack);
      }
      return pack;
    },

    async loadInstalled(config: CwPackConfig): Promise<LoadedPack[]> {
      const paths = config.paths ?? [];
      const installed = config.installed ?? [];
      const results: LoadedPack[] = [];

      for (const ref of installed) {
        const packId = ref.split("@")[0] ?? ref;
        const dir = await resolvePackDir(packId, paths);
        if (!dir) {
          continue;
        }
        results.push(await this.load(dir));
      }
      return results;
    },

    async install(source: string, config: CwPackConfig): Promise<LoadedPack> {
      if (source.startsWith("file://")) {
        return this.load(source.slice("file://".length));
      }
      const packId = source.replace(/^nexus:\/\//, "").split("@")[0] ?? source;
      const dir = await resolvePackDir(packId, config.paths ?? []);
      if (!dir) {
        throw new Error(`Pack not found: ${source}`);
      }
      return this.load(dir);
    },

    list(): LoadedPack[] {
      return [...loaded];
    },
  };
}

export type PackLoader = {
  load(packPath: string): Promise<LoadedPack>;
  loadInstalled(config: CwPackConfig): Promise<LoadedPack[]>;
  install(source: string, config: CwPackConfig): Promise<LoadedPack>;
  list(): LoadedPack[];
};
