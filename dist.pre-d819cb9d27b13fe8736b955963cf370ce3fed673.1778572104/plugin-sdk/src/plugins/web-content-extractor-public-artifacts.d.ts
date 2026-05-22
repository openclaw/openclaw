import type { PluginWebContentExtractorEntry } from "./web-content-extractor-types.js";
export declare function loadBundledWebContentExtractorEntriesFromDir(params: {
    dirName: string;
    pluginId: string;
}): PluginWebContentExtractorEntry[] | null;
