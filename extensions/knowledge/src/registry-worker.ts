// Worker-thread entry for the store registry. Registry SQLite and store
// provisioning file work run here, never on the Gateway main thread.
import { parentPort, workerData } from "node:worker_threads";
import { usePluginFilesLocation, type PluginFilesLocation } from "./plugin-files.js";
import { installWorkerSdkResolver } from "./worker-sdk-resolver.js";

// SAFETY: registry-client.ts constructs this worker with exactly this workerData shape.
const data = workerData as {
  sdk: Record<string, string>;
  files: PluginFilesLocation;
  stateRoot: string;
};
installWorkerSdkResolver(data.sdk);
usePluginFilesLocation(data.files);
const { serveRegistry } = await import("./registry-host.js");
serveRegistry(parentPort!, data.stateRoot);
