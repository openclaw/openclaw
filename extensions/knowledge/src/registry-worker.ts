// Worker-thread entry for the store registry. Registry SQLite and store
// provisioning file work run here, never on the Gateway main thread.
import { registerHooks } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import { usePluginFilesLocation, type PluginFilesLocation } from "./plugin-files.js";

// SAFETY: registry-client.ts constructs this worker with exactly this workerData shape.
const data = workerData as {
  sdk: Record<string, string>;
  files: PluginFilesLocation;
  stateRoot: string;
};
registerHooks({
  resolve(specifier, context, next) {
    const url = data.sdk[specifier];
    return url ? { url, shortCircuit: true } : next(specifier, context);
  },
});
usePluginFilesLocation(data.files);
const { serveRegistry } = await import("./registry-host.js");
serveRegistry(parentPort!, data.stateRoot);
