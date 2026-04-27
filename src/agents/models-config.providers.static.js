import path from "node:path";
import { pathToFileURL } from "node:url";
import { listBundledPluginMetadata } from "../plugins/bundled-plugin-metadata.js";
import { resolveBundledPluginPublicSurfacePath } from "../plugins/public-surface-runtime.js";
const PROVIDER_CATALOG_ARTIFACT_BASENAME = "provider-catalog.js";
const DEFAULT_PROVIDER_CATALOG_ROOT = path.resolve(import.meta.dirname, "../..");
let providerCatalogEntriesCache = null;
let providerCatalogModulesPromise = null;
let providerCatalogExportMapPromise = null;
export function resolveBundledProviderCatalogEntries(params) {
    const rootDir = params?.rootDir ?? DEFAULT_PROVIDER_CATALOG_ROOT;
    if (rootDir === DEFAULT_PROVIDER_CATALOG_ROOT && providerCatalogEntriesCache) {
        return providerCatalogEntriesCache;
    }
    const entries = [];
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
export async function loadBundledProviderCatalogModules(params) {
    const rootDir = params?.rootDir ?? DEFAULT_PROVIDER_CATALOG_ROOT;
    if (rootDir === DEFAULT_PROVIDER_CATALOG_ROOT && providerCatalogModulesPromise) {
        return providerCatalogModulesPromise;
    }
    const loadPromise = (async () => {
        const entries = resolveBundledProviderCatalogEntries({ rootDir });
        const modules = await Promise.all(entries.map(async (entry) => {
            const module = (await import(pathToFileURL(entry.artifactPath).href));
            return [entry.dirName, module];
        }));
        return Object.freeze(Object.fromEntries(modules));
    })();
    if (rootDir === DEFAULT_PROVIDER_CATALOG_ROOT) {
        providerCatalogModulesPromise = loadPromise;
    }
    return loadPromise;
}
export async function loadBundledProviderCatalogExportMap(params) {
    const rootDir = params?.rootDir ?? DEFAULT_PROVIDER_CATALOG_ROOT;
    if (rootDir === DEFAULT_PROVIDER_CATALOG_ROOT && providerCatalogExportMapPromise) {
        return providerCatalogExportMapPromise;
    }
    const loadPromise = (async () => {
        const modules = await loadBundledProviderCatalogModules({ rootDir });
        const exports = {};
        const exportOwners = new Map();
        for (const [dirName, module] of Object.entries(modules)) {
            for (const [exportName, exportValue] of Object.entries(module)) {
                if (exportName === "default") {
                    continue;
                }
                const existingOwner = exportOwners.get(exportName);
                if (existingOwner && existingOwner !== dirName) {
                    throw new Error(`Duplicate provider catalog export "${exportName}" from folders "${existingOwner}" and "${dirName}"`);
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
