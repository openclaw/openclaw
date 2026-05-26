import type { PluginDocumentExtractorEntry } from "./document-extractor-types.js";
export declare function loadBundledDocumentExtractorEntriesFromDir(params: {
    dirName: string;
    pluginId: string;
}): PluginDocumentExtractorEntry[] | null;
