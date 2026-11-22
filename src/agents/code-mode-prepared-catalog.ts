import {
  createCodeModeCatalogBindings,
  createCodeModeCatalogProjection,
} from "./code-mode-catalog.js";
import { createCodeModeNamespaceRuntime } from "./code-mode-namespaces.js";
import type { prepareCodeModeNodeCatalog } from "./code-mode-node-input.js";
import { compactToolSearchCatalogEntry } from "./tool-search-catalog.js";
import { getToolSearchCatalogDescriptors } from "./tool-search-prepared-catalog.js";
import type { ToolSearchCatalogEntry } from "./tool-search-types.js";

type PreparedCodeModeCatalog = {
  namespaceRuntime: ReturnType<typeof createCodeModeNamespaceRuntime>;
  catalogProjection: ReturnType<typeof createCodeModeCatalogProjection>;
  workerCatalogs: ReturnType<typeof prepareCodeModeNodeCatalog>[];
};

// The bounded descriptor owner controls lifetime. None of these projections bind
// a run; namespace invocation receives the current executor at the call boundary.
const preparedCatalogs = new WeakMap<
  object,
  {
    bindings: ReturnType<typeof createCodeModeCatalogBindings>;
    execution?: PreparedCodeModeCatalog;
  }
>();

function getCatalog(entries: readonly ToolSearchCatalogEntry[]) {
  const { descriptors } = getToolSearchCatalogDescriptors(entries);
  let catalog = preparedCatalogs.get(descriptors);
  if (!catalog) {
    catalog = {
      bindings: createCodeModeCatalogBindings(
        descriptors
          .filter((entry) => entry.source !== "mcp")
          .map((entry) => compactToolSearchCatalogEntry(entry)),
      ),
    };
    preparedCatalogs.set(descriptors, catalog);
  }
  return { catalog, descriptors };
}

export function getPreparedCodeModeCatalogBindings(entries: readonly ToolSearchCatalogEntry[]) {
  return getCatalog(entries).catalog.bindings;
}

export function getPreparedCodeModeCatalog(entries: readonly ToolSearchCatalogEntry[]) {
  const { catalog, descriptors } = getCatalog(entries);
  if (!catalog.execution) {
    const namespaceRuntime = createCodeModeNamespaceRuntime(descriptors);
    catalog.execution = {
      namespaceRuntime,
      catalogProjection: createCodeModeCatalogProjection(catalog.bindings, {
        reservedNames: namespaceRuntime.descriptors.map((descriptor) => descriptor.globalName),
        mcpIds: namespaceRuntime.mcpBindings.keys(),
      }),
      workerCatalogs: [],
    };
  }
  return catalog.execution;
}
