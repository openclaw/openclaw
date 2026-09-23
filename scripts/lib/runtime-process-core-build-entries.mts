import { fileURLToPath } from "node:url";
import { runtimeProcessEntrypoints } from "../../src/infra/runtime-process-entrypoints.ts";
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
];
export const runtimeProcessCoreBuildEntries = createRuntimeProcessBuildEntries(
  runtimeProcessCoreEntrypoints,
);

// Keep small helper processes out of the shared runtime bundle.
export const standaloneRuntimeProcessBuildEntries = createRuntimeProcessBuildEntries([
  runtimeProcessEntrypoints.sqliteReadOnly,
  runtimeProcessEntrypoints.stateRead,
  runtimeProcessEntrypoints.nativeHookRelayClient,
  runtimeProcessEntrypoints.spawnBroker,
  runtimeProcessEntrypoints.stateLeaseHeartbeat,
]);

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
