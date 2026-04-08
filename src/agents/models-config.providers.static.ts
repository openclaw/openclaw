import path from "node:path";
import { pathToFileURL } from "node:url";
import { listBundledPluginMetadata } from "../plugins/bundled-plugin-metadata.js";
import { resolveBundledPluginPublicSurfacePath } from "../plugins/public-surface-runtime.js";

const PROVIDER_CATALOG_ARTIFACT_BASENAME = "provider-catalog.js";
const DEFAULT_PROVIDER_CATALOG_ROOT = path.resolve(import.meta.dirname, "../..");

export type BundledProviderCatalogEntry = {
  dirName: string;
  pluginId: string;
  providers: readonly string[];
  artifactPath: string;
};

type ProviderCatalogModule = Record<string, unknown>;
type ProviderCatalogExportMap = Record<string, unknown>;
type ProviderCatalogDiscoveryDeps = {
  listBundledPluginMetadata?: typeof listBundledPluginMetadata;
  resolveBundledPluginPublicSurfacePath?: typeof resolveBundledPluginPublicSurfacePath;
};

let providerCatalogEntriesCache: ReadonlyArray<BundledProviderCatalogEntry> | null = null;
let providerCatalogModulesPromise: Promise<Readonly<Record<string, ProviderCatalogModule>>> | null =
  null;
let providerCatalogExportMapPromise: Promise<Readonly<ProviderCatalogExportMap>> | null = null;

export function resolveBundledProviderCatalogEntries(params?: {
  rootDir?: string;
  deps?: ProviderCatalogDiscoveryDeps;
}): ReadonlyArray<BundledProviderCatalogEntry> {
  const rootDir = params?.rootDir ?? DEFAULT_PROVIDER_CATALOG_ROOT;
  if (!params?.deps && rootDir === DEFAULT_PROVIDER_CATALOG_ROOT && providerCatalogEntriesCache) {
    return providerCatalogEntriesCache;
  }

  const entries: BundledProviderCatalogEntry[] = [];
  const listMetadata = params?.deps?.listBundledPluginMetadata ?? listBundledPluginMetadata;
  const resolvePublicSurfacePath =
    params?.deps?.resolveBundledPluginPublicSurfacePath ?? resolveBundledPluginPublicSurfacePath;
  for (const entry of listMetadata({ rootDir })) {
    if (!entry.publicSurfaceArtifacts?.includes(PROVIDER_CATALOG_ARTIFACT_BASENAME)) {
      continue;
    }
    const artifactPath = resolvePublicSurfacePath({
      rootDir,
      dirName: entry.dirName,
      artifactBasename: PROVIDER_CATALOG_ARTIFACT_BASENAME,
    });
    if (!artifactPath) {
      continue;
    }
    entries.push({
      dirName: entry.dirName,
      pluginId: entry.manifest.id,
      providers: entry.manifest.providers ?? [],
      artifactPath,
    });
  }
  entries.sort((left, right) => left.dirName.localeCompare(right.dirName));

  if (!params?.deps && rootDir === DEFAULT_PROVIDER_CATALOG_ROOT) {
    providerCatalogEntriesCache = entries;
  }
  return entries;
}

export async function loadBundledProviderCatalogModules(params?: {
  rootDir?: string;
  deps?: ProviderCatalogDiscoveryDeps;
}): Promise<Readonly<Record<string, ProviderCatalogModule>>> {
  const rootDir = params?.rootDir ?? DEFAULT_PROVIDER_CATALOG_ROOT;
  if (!params?.deps && rootDir === DEFAULT_PROVIDER_CATALOG_ROOT && providerCatalogModulesPromise) {
    return providerCatalogModulesPromise;
  }

  const loadPromise = (async () => {
    const entries = resolveBundledProviderCatalogEntries({ rootDir, deps: params?.deps });
    const modules = await Promise.all(
      entries.map(async (entry) => {
        const module = (await import(
          pathToFileURL(entry.artifactPath).href
        )) as ProviderCatalogModule;
        return [entry.dirName, module] as const;
      }),
    );
    return Object.freeze(Object.fromEntries(modules));
  })();

  if (!params?.deps && rootDir === DEFAULT_PROVIDER_CATALOG_ROOT) {
    providerCatalogModulesPromise = loadPromise;
  }
  return loadPromise;
}

export async function loadBundledProviderCatalogExportMap(params?: {
  rootDir?: string;
  deps?: ProviderCatalogDiscoveryDeps;
}): Promise<Readonly<ProviderCatalogExportMap>> {
  const rootDir = params?.rootDir ?? DEFAULT_PROVIDER_CATALOG_ROOT;
  if (
    !params?.deps &&
    rootDir === DEFAULT_PROVIDER_CATALOG_ROOT &&
    providerCatalogExportMapPromise
  ) {
    return providerCatalogExportMapPromise;
  }

  const loadPromise = (async () => {
    const modules = await loadBundledProviderCatalogModules({ rootDir, deps: params?.deps });
    const exports: ProviderCatalogExportMap = {};
    const exportOwners = new Map<string, string>();

    for (const [dirName, module] of Object.entries(modules)) {
      for (const [exportName, exportValue] of Object.entries(module)) {
        if (exportName === "default") {
          continue;
        }
        const existingOwner = exportOwners.get(exportName);
        if (existingOwner && existingOwner !== dirName) {
          throw new Error(
            `Duplicate provider catalog export "${exportName}" from folders "${existingOwner}" and "${dirName}"`,
          );
        }
        exportOwners.set(exportName, dirName);
        exports[exportName] = exportValue;
      }
    }

    return Object.freeze(exports);
  })();

  if (!params?.deps && rootDir === DEFAULT_PROVIDER_CATALOG_ROOT) {
    providerCatalogExportMapPromise = loadPromise;
  }
  return loadPromise;
}
