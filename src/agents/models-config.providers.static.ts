import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  listBundledPluginMetadata,
  resolveBundledPluginPublicSurfacePath,
} from "../plugins/bundled-plugin-metadata.js";
export { buildKilocodeProvider } from "../plugin-sdk/kilocode.js";
export { buildKimiCodingProvider } from "../plugin-sdk/kimi-coding.js";
export {
  QIANFAN_BASE_URL,
  QIANFAN_DEFAULT_MODEL_ID,
  buildQianfanProvider,
} from "../plugin-sdk/qianfan.js";
export { XIAOMI_DEFAULT_MODEL_ID, buildXiaomiProvider } from "../plugin-sdk/xiaomi.js";

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

let providerCatalogEntriesCache: ReadonlyArray<BundledProviderCatalogEntry> | null = null;
let providerCatalogModulesPromise: Promise<Readonly<Record<string, ProviderCatalogModule>>> | null =
  null;
let providerCatalogExportMapPromise: Promise<Readonly<ProviderCatalogExportMap>> | null = null;

export function resolveBundledProviderCatalogEntries(params?: {
  rootDir?: string;
}): ReadonlyArray<BundledProviderCatalogEntry> {
  const rootDir = params?.rootDir ?? DEFAULT_PROVIDER_CATALOG_ROOT;
  if (rootDir === DEFAULT_PROVIDER_CATALOG_ROOT && providerCatalogEntriesCache) {
    return providerCatalogEntriesCache;
  }

  const entries: BundledProviderCatalogEntry[] = [];
  for (const entry of listBundledPluginMetadata({ rootDir })) {
    if (!entry.publicSurfaceArtifacts?.includes(PROVIDER_CATALOG_ARTIFACT_BASENAME)) {
      continue;
    }
    const artifactPath = resolveBundledPluginPublicSurfacePath({
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

  if (rootDir === DEFAULT_PROVIDER_CATALOG_ROOT) {
    providerCatalogEntriesCache = entries;
  }
  return entries;
}

export async function loadBundledProviderCatalogModules(params?: {
  rootDir?: string;
}): Promise<Readonly<Record<string, ProviderCatalogModule>>> {
  const rootDir = params?.rootDir ?? DEFAULT_PROVIDER_CATALOG_ROOT;
  if (rootDir === DEFAULT_PROVIDER_CATALOG_ROOT && providerCatalogModulesPromise) {
    return providerCatalogModulesPromise;
  }

  const loadPromise = (async () => {
    const entries = resolveBundledProviderCatalogEntries({ rootDir });
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

  if (rootDir === DEFAULT_PROVIDER_CATALOG_ROOT) {
    providerCatalogModulesPromise = loadPromise;
  }
  return loadPromise;
}

export async function loadBundledProviderCatalogExportMap(params?: {
  rootDir?: string;
}): Promise<Readonly<ProviderCatalogExportMap>> {
  const rootDir = params?.rootDir ?? DEFAULT_PROVIDER_CATALOG_ROOT;
  if (rootDir === DEFAULT_PROVIDER_CATALOG_ROOT && providerCatalogExportMapPromise) {
    return providerCatalogExportMapPromise;
  }

  const loadPromise = (async () => {
    const modules = await loadBundledProviderCatalogModules({ rootDir });
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

  if (rootDir === DEFAULT_PROVIDER_CATALOG_ROOT) {
    providerCatalogExportMapPromise = loadPromise;
  }
  return loadPromise;
}
