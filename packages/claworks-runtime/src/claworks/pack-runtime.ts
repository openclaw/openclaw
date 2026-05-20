import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  installPackFromNexus,
  parseNexusSource,
  type CwPackConfig,
  type LoadedPack,
} from "../pack-loader/index.js";
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

export async function reloadClaworksPacks(runtime: ClaworksRuntime): Promise<void> {
  const persisted = await loadPersistedInstalled();
  const packConfig = mergePackConfig(runtime.config.packs, persisted);
  runtime.config.packs = packConfig;
  const packs = await runtime.packLoader.loadInstalled(packConfig);
  runtime.loadedPacks.splice(0, runtime.loadedPacks.length, ...packs);
  await runtime.ontology.loadFromPacks(packs);
  await runtime.playbookEngine.loadFromPacks(packs);
  runtime.kernel.matcher.load(runtime.playbookEngine.list());
  runtime.scheduler.reload(runtime.playbookEngine.list());
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
  const pack = await runtime.packLoader.load(dir);
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
