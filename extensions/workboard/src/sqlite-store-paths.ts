import { pathToFileURL } from "node:url";
import {
  createPluginRuntimeProcessEntrypoint,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";

export function resolveWorkboardSqliteWorkerModuleUrl(runtimeSource: string | undefined): URL {
  if (!runtimeSource) {
    throw new Error("Workboard requires runtime entrypoint metadata");
  }
  return resolveRuntimeWorkerUrl(
    createPluginRuntimeProcessEntrypoint("workboardSqlite", pathToFileURL(runtimeSource).href),
  );
}
