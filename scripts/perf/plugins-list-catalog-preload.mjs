// Synthetic I/O for plugins-list-measure.ts --preload: the real dist Gateway
// and inventory owner run unchanged; only the remote feed producer is replaced.
// Each process gets one five-second read returning the bundled fixture catalog.
import { registerHooks } from "node:module";
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (!/\/official-external-plugin-catalog-[^/]+\.mjs$/.test(url) || !loaded.source) {
        return loaded;
      }
      const source =
        typeof loaded.source === "string" ? loaded.source : new TextDecoder().decode(loaded.source);
      const declaration =
        "async function loadConfiguredHostedOfficialExternalPluginCatalogEntries(params) {";
      if (!source.includes(declaration)) {
        return loaded;
      }
      return {
        ...loaded,
        source: source.replace(
          declaration,
          `${declaration}
          console.log("[plugins-list-fixture] catalog read started");
          await new Promise(resolve => setTimeout(resolve, 5000));
          console.log("[plugins-list-fixture] catalog read completed");
          return { source: "bundled-fallback", entries: listOfficialExternalPluginCatalogEntries(), error: "synthetic catalog response" };
        `,
        ),
      };
    },
  });
}
