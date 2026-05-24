import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { installPackFromNexus, type CwPackConfig, type LoadedPack } from "../pack-loader/index.js";
import type { ClaworksRuntime } from "./runtime-types.js";

const INSTALLED_STATE_FILE = "packs-installed.json";

export function resolvePacksInstallRoot(): string {
  return join(homedir(), ".claworks", "packs");
}

export function resolveInstalledStatePath(): string {
  return join(homedir(), ".claworks", INSTALLED_STATE_FILE);
}

export async function loadPersistedInstalled(): Promise<string[]> {
  try {
    const raw = JSON.parse(await readFile(resolveInstalledStatePath(), "utf8")) as {
      installed?: string[];
    };
    return Array.isArray(raw.installed) ? raw.installed.map(String) : [];
  } catch {
    return [];
  }
}

export async function persistInstalled(installed: string[]): Promise<void> {
  await writeFile(
    resolveInstalledStatePath(),
    `${JSON.stringify({ installed: [...new Set(installed)] }, null, 2)}\n`,
    "utf8",
  );
}

export function mergePackConfig(
  config: CwPackConfig | undefined,
  persisted: string[],
): CwPackConfig {
  const installed = [...new Set([...(config?.installed ?? []), ...persisted])];
  const paths = [
    ...(config?.paths ?? []),
    resolvePacksInstallRoot(),
    join(process.cwd(), "packs"),
    join(process.cwd(), "../claworks-packs"),
  ];
  return {
    ...config,
    paths: [...new Set(paths)],
    installed,
  };
}

export async function applyPackContributions(
  runtime: ClaworksRuntime,
  packs: LoadedPack[],
  opts?: { clearRegistries?: boolean },
): Promise<void> {
  if (opts?.clearRegistries) {
    runtime.actionRegistry.clear();
    runtime.intentRegistry.clear();
  }

  for (const pack of packs) {
    if (pack.scaffolds?.length && runtime.scaffoldEngine) {
      for (const scaffold of pack.scaffolds) {
        runtime.scaffoldEngine.loadFromJson(scaffold as unknown as Record<string, unknown>);
      }
      runtime.logger?.(
        `[claworks:packs] registered ${pack.scaffolds.length} scaffolds from pack '${pack.manifest.id}'`,
      );
    }
  }

  for (const pack of packs) {
    if (!pack.factory) {
      continue;
    }
    try {
      const contribution = await pack.factory(runtime);
      if (contribution.capabilities?.length) {
        runtime.capabilities.registerAll(contribution.capabilities);
        runtime.logger?.(
          `[claworks:packs] registered ${contribution.capabilities.length} capabilities from pack '${pack.manifest.id}'`,
        );
      }
      if (contribution.actionHandlers && Object.keys(contribution.actionHandlers).length > 0) {
        runtime.actionRegistry.registerAll(pack.manifest.id, contribution.actionHandlers);
        runtime.logger?.(
          `[claworks:packs] registered ${Object.keys(contribution.actionHandlers).length} action handlers from pack '${pack.manifest.id}'`,
        );
      }
      if (contribution.intentMappings?.length) {
        runtime.intentRegistry.registerAll(pack.manifest.id, contribution.intentMappings);
        runtime.logger?.(
          `[claworks:packs] registered ${contribution.intentMappings.length} intent mappings from pack '${pack.manifest.id}'`,
        );
      }
      if (contribution.scripts?.length) {
        runtime.scriptLibrary?.registerFromPack(
          pack.manifest.id,
          contribution.scripts as Parameters<
            NonNullable<typeof runtime.scriptLibrary>["registerFromPack"]
          >[1],
        );
        runtime.logger?.(
          `[claworks:packs] registered ${contribution.scripts.length} scripts from pack '${pack.manifest.id}'`,
        );
      }
      if (contribution.scaffolds?.length && runtime.scaffoldEngine) {
        for (const scaffold of contribution.scaffolds) {
          runtime.scaffoldEngine.loadFromJson(scaffold as unknown as Record<string, unknown>);
        }
        runtime.logger?.(
          `[claworks:packs] registered ${contribution.scaffolds.length} code scaffolds from pack '${pack.manifest.id}'`,
        );
      }
      if (contribution.objectTypes?.length) {
        for (const typeDef of contribution.objectTypes) {
          runtime.ontology?.registerType?.(typeDef);
        }
        runtime.logger?.(
          `[claworks:packs] registered ${contribution.objectTypes.length} object types from pack '${pack.manifest.id}'`,
        );
      }
      if (contribution.playbooks?.length) {
        for (const playbook of contribution.playbooks) {
          runtime.playbookEngine.load(playbook);
        }
        runtime.kernel.matcher.load(runtime.playbookEngine.list());
        runtime.scheduler.reload(runtime.playbookEngine.list());
        runtime.logger?.(
          `[claworks:packs] registered ${contribution.playbooks.length} code playbooks from pack '${pack.manifest.id}'`,
        );
      }
      if (contribution.hooks?.length) {
        for (const hook of contribution.hooks) {
          runtime.kernel?.bus?.subscribe?.(hook.event, async (e) => {
            await hook.handler(e.payload as Record<string, unknown>);
          });
        }
        runtime.logger?.(
          `[claworks:packs] registered ${contribution.hooks.length} hooks from pack '${pack.manifest.id}'`,
        );
      }
      if (contribution.promptTemplates?.length && runtime.scaffoldEngine) {
        for (const tmpl of contribution.promptTemplates) {
          runtime.scaffoldEngine.loadFromJson(tmpl as unknown as Record<string, unknown>);
        }
        runtime.logger?.(
          `[claworks:packs] registered ${contribution.promptTemplates.length} prompt templates from pack '${pack.manifest.id}'`,
        );
      }
      if (contribution.onLoad) {
        await contribution.onLoad(runtime);
      }
    } catch (err) {
      runtime.logger?.(
        `[claworks:packs] factory error in pack '${pack.manifest.id}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export async function reloadClaworksPacks(runtime: ClaworksRuntime): Promise<void> {
  const persisted = await loadPersistedInstalled();
  const packConfig = mergePackConfig(runtime.config.packs, persisted);
  runtime.config.packs = packConfig;
  const packs = await runtime.packLoader.loadInstalled(packConfig, runtime.logger);
  runtime.loadedPacks.splice(0, runtime.loadedPacks.length, ...packs);
  await runtime.ontology.loadFromPacks(packs);
  await runtime.playbookEngine.loadFromPacks(packs);
  runtime.kernel.matcher.load(runtime.playbookEngine.list());
  runtime.scheduler.reload(runtime.playbookEngine.list());

  await applyPackContributions(runtime, packs, { clearRegistries: true });

  // Pack 加载后同步 RBAC / Ingress 策略（从 ObjectStore 可靠数据读取）
  const { syncRbacFromObjectStore, syncIngressFromObjectStore } = await import("./rbac-sync.js");
  await syncRbacFromObjectStore(runtime);
  await syncIngressFromObjectStore(runtime);
}

export async function reloadClaworksPackById(
  runtime: ClaworksRuntime,
  packId: string,
): Promise<LoadedPack | null> {
  const { resolvePackDir } = await import("../pack-loader/index.js");
  const dir = await resolvePackDir(packId, runtime.config.packs?.paths ?? []);
  if (!dir) {
    return null;
  }
  const pack = await runtime.packLoader.load(dir, runtime.logger);
  const idx = runtime.loadedPacks.findIndex((p) => p.manifest.id === packId);
  if (idx >= 0) {
    runtime.loadedPacks[idx] = pack;
  } else {
    runtime.loadedPacks.push(pack);
  }
  await runtime.ontology.reloadPack(packId, pack);
  await runtime.playbookEngine.loadFromPacks(runtime.loadedPacks);
  runtime.kernel.matcher.load(runtime.playbookEngine.list());
  runtime.scheduler.reload(runtime.playbookEngine.list());

  // 注册文件系统加载的 scaffolds
  if (pack.scaffolds?.length && runtime.scaffoldEngine) {
    for (const scaffold of pack.scaffolds) {
      runtime.scaffoldEngine.loadFromJson(scaffold as unknown as Record<string, unknown>);
    }
    runtime.logger?.(
      `[claworks:packs] registered ${pack.scaffolds.length} scaffolds from pack '${packId}'`,
    );
  }

  // 调用 Pack JS factory 注册能力 / action handlers / intent mappings / scaffolds
  if (pack.factory) {
    try {
      const contribution = await pack.factory(runtime);
      if (contribution.capabilities?.length) {
        runtime.capabilities.registerAll(contribution.capabilities);
        runtime.logger?.(
          `[claworks:packs] registered ${contribution.capabilities.length} capabilities from pack '${packId}'`,
        );
      }
      if (contribution.actionHandlers && Object.keys(contribution.actionHandlers).length > 0) {
        runtime.actionRegistry.registerAll(packId, contribution.actionHandlers);
        runtime.logger?.(
          `[claworks:packs] registered ${Object.keys(contribution.actionHandlers).length} action handlers from pack '${packId}'`,
        );
      }
      if (contribution.intentMappings?.length) {
        runtime.intentRegistry.registerAll(packId, contribution.intentMappings);
        runtime.logger?.(
          `[claworks:packs] registered ${contribution.intentMappings.length} intent mappings from pack '${packId}'`,
        );
      }
      if (contribution.scripts?.length) {
        runtime.scriptLibrary?.registerFromPack(
          packId,
          contribution.scripts as Parameters<
            NonNullable<typeof runtime.scriptLibrary>["registerFromPack"]
          >[1],
        );
        runtime.logger?.(
          `[claworks:packs] registered ${contribution.scripts.length} scripts from pack '${packId}'`,
        );
      }
      if (contribution.scaffolds?.length && runtime.scaffoldEngine) {
        for (const scaffold of contribution.scaffolds) {
          runtime.scaffoldEngine.loadFromJson(scaffold as unknown as Record<string, unknown>);
        }
        runtime.logger?.(
          `[claworks:packs] registered ${contribution.scaffolds.length} code scaffolds from pack '${packId}'`,
        );
      }
      if (contribution.onLoad) {
        await contribution.onLoad(runtime);
      }
    } catch (err) {
      runtime.logger?.(
        `[claworks:packs] factory error in pack '${packId}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return pack;
}

async function markInstalled(packId: string): Promise<void> {
  const persisted = await loadPersistedInstalled();
  if (!persisted.includes(packId)) {
    persisted.push(packId);
    await persistInstalled(persisted);
  }
}

export async function installClaworksPack(
  runtime: ClaworksRuntime,
  source: string,
): Promise<{ pack: LoadedPack; installed: string[] }> {
  const registry =
    runtime.config.packs?.registry ?? process.env.CLAWORKS_NEXUS_URL ?? "http://127.0.0.1:8080";

  let packId: string;

  if (source.startsWith("file://")) {
    const pack = await runtime.packLoader.load(source.slice("file://".length));
    packId = pack.manifest.id;
    await markInstalled(packId);
  } else if (source.startsWith("nexus://") || !source.includes("/")) {
    const nexusSource = source.startsWith("nexus://") ? source : `nexus://${source}`;
    const { slug } = await installPackFromNexus({
      registry,
      source: nexusSource,
      installRoot: resolvePacksInstallRoot(),
    });
    packId = slug;
    await markInstalled(packId);
  } else {
    const loaded = await runtime.packLoader.install(source, runtime.config.packs ?? {});
    packId = loaded.manifest.id;
    await markInstalled(packId);
  }

  await reloadClaworksPacks(runtime);
  const pack = runtime.loadedPacks.find((p) => p.manifest.id === packId);
  if (!pack) {
    throw new Error(`Pack install completed but pack not loaded: ${packId}`);
  }
  return { pack, installed: runtime.config.packs?.installed ?? [] };
}

export async function uninstallClaworksPack(
  runtime: ClaworksRuntime,
  packId: string,
): Promise<string[]> {
  const persisted = (await loadPersistedInstalled()).filter((id) => id !== packId);
  await persistInstalled(persisted);
  runtime.config.packs = {
    ...runtime.config.packs,
    installed: (runtime.config.packs?.installed ?? []).filter((id) => id !== packId),
  };
  await reloadClaworksPacks(runtime);
  return runtime.config.packs?.installed ?? [];
}

/** Re-install pack from Nexus or local path (same as install; refreshes artifacts). */
export async function updateClaworksPack(
  runtime: ClaworksRuntime,
  source: string,
): Promise<{ pack: LoadedPack; installed: string[] }> {
  return await installClaworksPack(runtime, source);
}

export async function reloadClaworksPacksFromDisk(
  runtime: ClaworksRuntime,
): Promise<{ packs: LoadedPack[] }> {
  await reloadClaworksPacks(runtime);
  return { packs: runtime.loadedPacks };
}

export async function searchNexusPackages(
  runtime: ClaworksRuntime,
  q?: string,
): Promise<Awaited<ReturnType<typeof import("../pack-loader/index.js").listNexusPackages>>> {
  const { listNexusPackages } = await import("../pack-loader/index.js");
  const registry =
    runtime.config.packs?.registry ?? process.env.CLAWORKS_NEXUS_URL ?? "http://127.0.0.1:8080";
  return await listNexusPackages(registry, { q });
}
