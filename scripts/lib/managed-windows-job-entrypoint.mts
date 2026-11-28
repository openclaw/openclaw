import { extname } from "node:path";
import { fileURLToPath } from "node:url";

export const managedWindowsJobEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "managed-windows-job-launcher",
  sourceExtension: ".mts",
  distWorkerPath: "tooling/managed-windows-job-launcher.js",
} as const;

/** Tooling preflight has no application dependencies, including for worker resolution. */
export function resolveManagedWindowsJobEntrypointUrl(): URL {
  const current = new URL(import.meta.url);
  const distIndex = current.pathname.lastIndexOf("/dist/");
  return distIndex < 0
    ? new URL(
        `./${managedWindowsJobEntrypoint.sourceWorkerName}${extname(fileURLToPath(current))}`,
        current,
      )
    : new URL(
        `${current.pathname.slice(0, distIndex + 6)}${managedWindowsJobEntrypoint.distWorkerPath}`,
        current,
      );
}
