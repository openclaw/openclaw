import { fileURLToPath } from "node:url";
import { runtimeProcessEntrypoints } from "../../src/infra/runtime-process-entrypoints.ts";

export function createRuntimeProcessBuildEntries(
  entries: readonly {
    currentModuleUrl: string;
    sourceWorkerName: string;
    distWorkerPath: string;
  }[],
) {
  return Object.fromEntries(
    entries.map((entry) => [
      entry.distWorkerPath.replace(/\.js$/u, ""),
      fileURLToPath(new URL(`./${entry.sourceWorkerName}.ts`, entry.currentModuleUrl)),
    ]),
  );
}

export const runtimeProcessCoreBuildEntries = createRuntimeProcessBuildEntries(
  Object.values(runtimeProcessEntrypoints),
);

// Keep small helper processes out of the shared runtime bundle.
export const standaloneRuntimeProcessBuildEntries = createRuntimeProcessBuildEntries([
  runtimeProcessEntrypoints.sqliteReadOnly,
  runtimeProcessEntrypoints.nativeHookRelayClient,
  runtimeProcessEntrypoints.spawnBroker,
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
