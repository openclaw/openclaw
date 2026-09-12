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

// Short-lived snapshot children own a separate bundle; parents retain shared runtime identity.
export const standaloneRuntimeProcessBuildEntries = createRuntimeProcessBuildEntries([
  runtimeProcessEntrypoints.sqliteReadOnly,
]);

export function sharedRuntimeProcessBuildEntries(entries: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(entries).filter(
      ([name]) => !Object.hasOwn(standaloneRuntimeProcessBuildEntries, name),
    ),
  );
}
