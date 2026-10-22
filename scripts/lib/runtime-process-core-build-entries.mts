import { fileURLToPath } from "node:url";
import { runtimeProcessEntrypoints } from "../../src/infra/runtime-process-entrypoints.ts";
import { managedMemoryEntrypoint } from "./managed-memory-entrypoint.mts";
import { managedWindowsJobEntrypoint } from "./managed-windows-job-entrypoint.mts";

export function createRuntimeProcessBuildEntries(
  entries: readonly {
    currentModuleUrl: string;
    sourceWorkerName: string;
    distWorkerPath: string;
    sourceExtension?: ".ts" | ".mts";
  }[],
) {
  return Object.fromEntries(
    entries.map((entry) => [
      entry.distWorkerPath.replace(/\.js$/u, ""),
      fileURLToPath(
        new URL(
          `./${entry.sourceWorkerName}${entry.sourceExtension ?? ".ts"}`,
          entry.currentModuleUrl,
        ),
      ),
    ]),
  );
}

export const runtimeProcessCoreEntrypoints = [
  ...Object.values(runtimeProcessEntrypoints),
  managedWindowsJobEntrypoint,
  managedMemoryEntrypoint,
];

// Keep small helper processes out of the shared runtime bundle.
export const standaloneRuntimeProcessBuildEntries = createRuntimeProcessBuildEntries([
  managedMemoryEntrypoint,
  runtimeProcessEntrypoints.pluginGenerationPreparation,
  runtimeProcessEntrypoints.sqliteReadOnly,
  runtimeProcessEntrypoints.sqliteSourceRevision,
  runtimeProcessEntrypoints.stateRead,
  runtimeProcessEntrypoints.nativeHookRelayClient,
  runtimeProcessEntrypoints.spawnBroker,
  runtimeProcessEntrypoints.stateLeaseHeartbeat,
  runtimeProcessEntrypoints.gatewayStateOwnerHeartbeat,
  runtimeProcessEntrypoints.serviceChildRelay,
  runtimeProcessEntrypoints.serviceChildGroupAnchor,
]);

export function getStandaloneRuntimeProcessOutputOptions(name: string) {
  const pluginPreparationEntry =
    runtimeProcessEntrypoints.pluginGenerationPreparation.distWorkerPath.replace(/\.js$/u, "");
  const stateReadEntry = runtimeProcessEntrypoints.stateRead.distWorkerPath.replace(/\.js$/u, "");
  const sqliteReadEntry = runtimeProcessEntrypoints.sqliteReadOnly.distWorkerPath.replace(
    /\.js$/u,
    "",
  );
  if (name === pluginPreparationEntry) {
    // Each retained plugin has its own worker. Shared gateway chunks multiply
    // their resident cost; keep diagnostics lazy inside this private graph.
    return { codeSplitting: true, chunkFileNames: "plugins/plugin-preparation-[name]-[hash].mjs" };
  }
  // Keep optional read handlers lazy without sharing the main runtime graph.
  if (name === stateReadEntry) {
    return { codeSplitting: true, chunkFileNames: "state/openclaw-state-read-[name]-[hash].mjs" };
  }
  if (name === sqliteReadEntry) {
    return { codeSplitting: true, chunkFileNames: "infra/sqlite-readonly-[name]-[hash].mjs" };
  }
  return { codeSplitting: false };
}

export function shouldBundleRuntimeSqliteDependency(id: string): boolean {
  return id === "kysely" || id.startsWith("kysely/");
}

export function sharedRuntimeProcessBuildEntries(entries: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(entries).filter(
      ([name]) => !Object.hasOwn(standaloneRuntimeProcessBuildEntries, name),
    ),
  );
}
