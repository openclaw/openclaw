// Locates Knowledge's packaged files: worker entrypoints, the bundled ontology
// and the sample vault. Built output moves shared modules into host chunks, so
// module-relative URLs cannot find them; the host-selected entry file can.
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The plugin package root and the module extension its entry runs from. */
export type PluginFilesLocation = { root: string; extension: string };

// Source layout (tests, source checkouts): this module sits in <root>/src.
let location: PluginFilesLocation = {
  root: fileURLToPath(new URL("..", import.meta.url)),
  extension: path.extname(fileURLToPath(import.meta.url)),
};

/** Locate packaged files from the host-selected runtime entry (index.ts or index.js). */
export function locatePluginFiles(runtimeSource: string): void {
  location = { root: path.dirname(runtimeSource), extension: path.extname(runtimeSource) };
}

/** Adopt the main thread's location inside a worker thread. */
export function usePluginFilesLocation(next: PluginFilesLocation): void {
  location = next;
}

/** Current location, passed to worker threads. */
export const pluginFilesLocation = (): PluginFilesLocation => location;

/** Directory holding the bundled default ontology. */
export const ontologyRoot = (): string => path.join(location.root, "ontologies");

/** Directory holding the read-only sample vault. */
export const sampleVaultRoot = (): string => path.join(location.root, "fixtures", "sample-vault");
