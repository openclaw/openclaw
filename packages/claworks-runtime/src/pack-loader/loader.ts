import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import type { PackFactory } from "./pack-sdk.js";
import type {
  PackDependencyError,
  PackLoader,
  CwPackConfig,
  LoadedPack,
  PackManifest,
} from "./types.js";
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

/**
 * Resolve the pack manifest from either `claworks.pack.json` (legacy) or `pack.yaml` (new format).
 * pack.yaml uses a top-level `pack:` key and `requires:` for structured dependencies.
 */
export async function readPackManifestFromDir(packDir: string): Promise<PackManifest> {
  return resolveManifest(packDir);
}

async function resolveManifest(packDir: string): Promise<PackManifest> {
  // Prefer the canonical JSON manifest
  const jsonPath = join(packDir, "claworks.pack.json");
  try {
    await stat(jsonPath);
    return await readPackManifest(jsonPath);
  } catch {
    // fall through to pack.yaml
  }

  const yamlPath = join(packDir, "pack.yaml");
  try {
    const raw = parseYaml(await readFile(yamlPath, "utf8")) as Record<string, unknown>;
    const p = (raw?.pack ?? raw) as Record<string, unknown>;
    if (!p?.id) {
      throw new Error(`pack.yaml missing id in ${packDir}`);
    }
    const requires = Array.isArray(p.requires)
      ? (p.requires as Array<Record<string, unknown>>).map((r) => ({
          id: String(r.id ?? ""),
          version: r.version ? String(r.version) : undefined,
          optional: r.optional === true,
        }))
      : undefined;

    const objectTypes = Array.isArray(p.objectTypes) ? (p.objectTypes as string[]) : [];
    const actionTypes = Array.isArray(p.actionTypes) ? (p.actionTypes as string[]) : [];
    const playbooks = Array.isArray(p.playbooks) ? (p.playbooks as string[]) : [];

    return {
      id: String(p.id),
      name: String(p.display_name ?? p.name ?? p.id),
      version: String(p.version ?? "0.1.0"),
      description: p.description ? String(p.description) : undefined,
      license: String(p.license ?? "proprietary"),
      requires,
      provides: { objectTypes, actionTypes, playbooks },
    };
  } catch (err) {
    throw new Error(
      `No claworks.pack.json or pack.yaml found in ${packDir}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/**
 * Validate that all non-optional `requires` entries are satisfied by the loaded pack set.
 * Returns a list of errors (empty = all dependencies satisfied).
 */
export function validatePackDependencies(
  packs: LoadedPack[],
  logger?: (msg: string) => void,
): PackDependencyError[] {
  const loadedById = new Map(packs.map((p) => [p.manifest.id, p.manifest.version]));
  const errors: PackDependencyError[] = [];

  for (const pack of packs) {
    const requires = pack.manifest.requires ?? [];
    for (const dep of requires) {
      const installedVersion = loadedById.get(dep.id);
      if (!installedVersion) {
        if (dep.optional) {
          logger?.(
            `[claworks:packs] optional dependency ${dep.id} for pack ${pack.manifest.id} not installed`,
          );
          continue;
        }
        errors.push({
          packId: pack.manifest.id,
          dependencyId: dep.id,
          reason: `required pack '${dep.id}' is not loaded`,
        });
        continue;
      }
      // Simple version check: if dep.version is ">=X.Y.Z", compare major.minor.patch
      if (dep.version) {
        const match = dep.version.match(/^(>=|<=|=|>|<)\s*(\d+\.\d+\.\d+)$/);
        if (match) {
          const [, op, reqVersion] = match;
          const cmp = compareVersions(installedVersion, reqVersion);
          const satisfied =
            op === ">="
              ? cmp >= 0
              : op === "<="
                ? cmp <= 0
                : op === ">"
                  ? cmp > 0
                  : op === "<"
                    ? cmp < 0
                    : cmp === 0;
          if (!satisfied) {
            if (dep.optional) {
              logger?.(
                `[claworks:packs] optional dep ${dep.id}@${dep.version} for pack ${pack.manifest.id} version mismatch (installed: ${installedVersion})`,
              );
            } else {
              errors.push({
                packId: pack.manifest.id,
                dependencyId: dep.id,
                reason: `pack '${dep.id}' version ${installedVersion} does not satisfy ${dep.version}`,
              });
            }
          }
        }
      }
    }
  }
  return errors;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * Try to load a Pack entry file (PackFactory).
 * Candidate paths (in priority order):
 *   1. manifest.entry (relative to packDir)
 *   2. index.js  (compiled ESM output)
 *   3. index.ts  (ts-node / tsx / Bun environments)
 *   4. src/index.js
 */
async function tryLoadFactory(
  packDir: string,
  manifest: PackManifest,
  logger?: (msg: string) => void,
): Promise<PackFactory | undefined> {
  const candidates: string[] = [];
  if (manifest.entry) {
    candidates.push(join(packDir, manifest.entry));
    if (manifest.entry.endsWith(".js")) {
      candidates.push(join(packDir, manifest.entry.replace(/\.js$/, ".ts")));
    }
  } else {
    candidates.push(
      join(packDir, "index.js"),
      join(packDir, "index.ts"),
      join(packDir, "src", "index.js"),
      join(packDir, "src", "index.ts"),
    );
  }

  for (const candidate of candidates) {
    try {
      await stat(candidate);
      const fileUrl = pathToFileURL(candidate).href;
      const mod = (await import(fileUrl)) as { default?: PackFactory };
      if (typeof mod.default === "function") {
        logger?.(`[claworks:packs] loaded entry for pack '${manifest.id}': ${candidate}`);
        return mod.default;
      }
    } catch {
      // not found or not a valid factory — try next candidate
    }
  }
  return undefined;
}

async function loadPackFromDir(
  packDir: string,
  logger?: (msg: string) => void,
): Promise<LoadedPack> {
  const manifest = await resolveManifest(packDir);
  const ontologyDir = join(packDir, "ontology");

  const objectTypes = [];
  for (const file of await listYamlFiles(join(ontologyDir, "object_types"))) {
    const content = await readFile(file, "utf8");
    objectTypes.push(parseObjectTypeYaml(content, manifest.id, file));
  }

  const playbooks = [];
  // Load main playbooks dir
  for (const file of await listYamlFiles(join(ontologyDir, "playbooks"))) {
    const content = await readFile(file, "utf8");
    playbooks.push(parsePlaybookYaml(content, manifest.id));
  }
  // Load template playbooks from playbooks/templates/ subdirectory
  for (const file of await listYamlFiles(join(ontologyDir, "playbooks", "templates"))) {
    const content = await readFile(file, "utf8");
    playbooks.push(parsePlaybookYaml(content, manifest.id));
  }

  // Load skills (*.skill.ts / *.skill.js) — register metadata only; factory wires impl
  const skills: import("./types.js").SkillModule[] = [];
  const skillsDir = join(packDir, "skills");
  try {
    const skillEntries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of skillEntries) {
      if (entry.isFile() && /\.skill\.(ts|js)$/.test(entry.name)) {
        const skillId = entry.name.replace(/\.skill\.(ts|js)$/, "");
        skills.push({ id: skillId, filePath: join(skillsDir, entry.name), packId: manifest.id });
        logger?.(`[claworks:packs] discovered skill '${skillId}' in pack '${manifest.id}'`);
      }
    }
  } catch {
    // no skills dir — fine
  }

  // Load scaffolds (*.json with prompt_template field)
  const scaffolds: import("./types.js").ScaffoldTemplate[] = [];
  const scaffoldsDir = join(packDir, "scaffolds");
  try {
    const scaffoldEntries = await readdir(scaffoldsDir, { withFileTypes: true });
    for (const entry of scaffoldEntries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        try {
          const raw = JSON.parse(await readFile(join(scaffoldsDir, entry.name), "utf8")) as Record<
            string,
            unknown
          >;
          if (raw.id && raw.prompt_template) {
            scaffolds.push({
              id: String(raw.id),
              description: raw.description ? String(raw.description) : undefined,
              prompt_template: String(raw.prompt_template),
              output_schema: raw.output_schema as Record<string, unknown> | undefined,
              output_parser: raw.output_parser ? String(raw.output_parser) : undefined,
              output_parser_config: raw.output_parser_config as Record<string, unknown> | undefined,
              recommended_models: Array.isArray(raw.recommended_models)
                ? raw.recommended_models.map(String)
                : undefined,
              max_tokens: typeof raw.max_tokens === "number" ? raw.max_tokens : undefined,
              temperature: typeof raw.temperature === "number" ? raw.temperature : undefined,
              examples: Array.isArray(raw.examples)
                ? (raw.examples as Array<{
                    input: Record<string, unknown>;
                    output: Record<string, unknown>;
                  }>)
                : undefined,
              packId: manifest.id,
            });
            logger?.(`[claworks:packs] loaded scaffold '${raw.id}' in pack '${manifest.id}'`);
          }
        } catch {
          logger?.(
            `[claworks:packs] failed to parse scaffold '${entry.name}' in pack '${manifest.id}'`,
          );
        }
      }
    }
  } catch {
    // no scaffolds dir — fine
  }

  const factory = await tryLoadFactory(packDir, manifest, logger);

  return { manifest, path: packDir, objectTypes, playbooks, factory, skills, scaffolds };
}

/**
 * Expand installed pack IDs with non-optional `requires` dependencies (transitive).
 * Returns a load order where dependencies precede dependents.
 */
export async function resolveInstalledPackIds(
  installed: string[],
  searchPaths: string[],
  logger?: (msg: string) => void,
): Promise<string[]> {
  const seed = installed.map((ref) => ref.split("@")[0] ?? ref).filter(Boolean);
  const discovered = new Set<string>();
  const manifests = new Map<string, PackManifest>();

  const queue = [...seed];
  while (queue.length > 0) {
    const packId = queue.shift();
    if (!packId || discovered.has(packId)) {
      continue;
    }
    discovered.add(packId);

    const dir = await resolvePackDir(packId, searchPaths);
    if (!dir) {
      logger?.(`[claworks:packs] pack not found during dependency resolve: ${packId}`);
      continue;
    }

    let manifest: PackManifest;
    try {
      manifest = await resolveManifest(dir);
    } catch (err) {
      logger?.(
        `[claworks:packs] failed to read manifest for '${packId}': ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    manifests.set(packId, manifest);

    for (const dep of manifest.requires ?? []) {
      if (dep.optional) {
        continue;
      }
      if (!discovered.has(dep.id)) {
        queue.push(dep.id);
      }
    }
  }

  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (packId: string) => {
    if (visited.has(packId)) {
      return;
    }
    if (visiting.has(packId)) {
      return;
    }
    visiting.add(packId);
    const manifest = manifests.get(packId);
    for (const dep of manifest?.requires ?? []) {
      if (!dep.optional && discovered.has(dep.id)) {
        visit(dep.id);
      }
    }
    visiting.delete(packId);
    visited.add(packId);
    ordered.push(packId);
  };

  for (const packId of seed) {
    if (discovered.has(packId)) {
      visit(packId);
    }
  }
  for (const packId of discovered) {
    if (!visited.has(packId)) {
      visit(packId);
    }
  }

  return ordered;
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
    async load(packPath: string, logger?: (msg: string) => void): Promise<LoadedPack> {
      const pack = await loadPackFromDir(packPath, logger);
      const existing = loaded.findIndex((p) => p.manifest.id === pack.manifest.id);
      if (existing >= 0) {
        loaded[existing] = pack;
      } else {
        loaded.push(pack);
      }
      return pack;
    },

    async loadInstalled(
      config: CwPackConfig,
      logger?: (msg: string) => void,
    ): Promise<LoadedPack[]> {
      const paths = config.paths ?? [];
      const installed = config.installed ?? [];
      const expanded = await resolveInstalledPackIds(installed, paths, logger);
      if (expanded.length > installed.length) {
        const added = expanded.filter(
          (id) => !installed.some((ref) => (ref.split("@")[0] ?? ref) === id),
        );
        if (added.length > 0) {
          logger?.(`[claworks:packs] auto-installed required dependencies: ${added.join(", ")}`);
        }
      }
      const results: LoadedPack[] = [];

      for (const packId of expanded) {
        const dir = await resolvePackDir(packId, paths);
        if (!dir) {
          logger?.(`[claworks:packs] pack not found: ${packId}`);
          continue;
        }
        results.push(await this.load(dir, logger));
      }

      // Validate inter-pack dependencies after all packs are loaded
      const depErrors = validatePackDependencies(results, logger);
      for (const err of depErrors) {
        logger?.(`[claworks:packs] dependency error in pack '${err.packId}': ${err.reason}`);
      }

      return results;
    },

    async install(
      source: string,
      config: CwPackConfig,
      logger?: (msg: string) => void,
    ): Promise<LoadedPack> {
      if (source.startsWith("file://")) {
        return this.load(source.slice("file://".length), logger);
      }
      const packId = source.replace(/^nexus:\/\//, "").split("@")[0] ?? source;
      const dir = await resolvePackDir(packId, config.paths ?? []);
      if (!dir) {
        throw new Error(`Pack not found: ${source}`);
      }
      return this.load(dir, logger);
    },

    list(): LoadedPack[] {
      return [...loaded];
    },
  };
}
