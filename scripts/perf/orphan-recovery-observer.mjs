// Diagnostics only: mark completion of the real startup inventory, without changing its decisions.
import { registerHooks } from "node:module";
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  let installed = false;
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (loaded.source == null) {
        return loaded;
      }
      const source =
        typeof loaded.source === "string" ? loaded.source : new TextDecoder().decode(loaded.source);
      if (!source.includes("async function cleanupPendingWorkspaceResultOrphans(")) {
        return loaded;
      }
      const marker = "pass.initialDiscoveryPending = false;";
      if (installed || source.split(marker).length !== 2 || !source.includes("const attempts =")) {
        throw new Error("Orphan discovery observation source changed");
      }
      installed = true;
      process.send?.({ type: "orphan-recovery-observer-installed", url });
      return {
        ...loaded,
        source: source.replace(
          marker,
          `process.send?.({ type: "orphan-recovery-sweep", initial: pass.initialDiscoveryPending, attempts, at: Date.now() });\n${marker}`,
        ),
      };
    },
  });
}
