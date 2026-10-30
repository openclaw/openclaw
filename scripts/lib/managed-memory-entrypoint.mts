import { extname } from "node:path";
import { fileURLToPath } from "node:url";

export const managedMemoryEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "managed-memory-launcher",
  sourceExtension: ".mts",
  distWorkerPath: "tooling/managed-memory-launcher.js",
} as const;

/** Resolve the standalone launcher in source checkouts and packaged tooling. */
export function resolveManagedMemoryEntrypointUrl(): URL {
  const current = new URL(import.meta.url);
  const distIndex = current.pathname.lastIndexOf("/dist/");
  return distIndex < 0
    ? new URL(`./managed-memory-launcher${extname(fileURLToPath(current))}`, current)
    : new URL(
        current.pathname.slice(0, distIndex + 6) + managedMemoryEntrypoint.distWorkerPath,
        current,
      );
}
