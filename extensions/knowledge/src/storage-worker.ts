// Worker-thread entry. Knowledge storage (SQLite, Git and vault file work) runs
// here so it never blocks the Gateway's main thread.
import { registerHooks } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import { usePluginFilesLocation, type PluginFilesLocation } from "./plugin-files.js";

// SAFETY: storage-client.ts constructs this worker with exactly this workerData shape.
const data = workerData as {
  sdk: Record<string, string>;
  files: PluginFilesLocation;
  config: import("./real-vault.js").StoreConfig;
  signal: SharedArrayBuffer;
};
// The host's plugin SDK resolver is installed on the main thread only. Reuse the
// exact module files the main thread resolved so both threads load one SDK.
registerHooks({
  resolve(specifier, context, next) {
    const url = data.sdk[specifier];
    return url ? { url, shortCircuit: true } : next(specifier, context);
  },
});
usePluginFilesLocation(data.files);
const { serve } = await import("./storage-host.js");
serve(parentPort!, data);
