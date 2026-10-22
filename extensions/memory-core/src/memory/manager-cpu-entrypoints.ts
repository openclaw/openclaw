import path from "node:path";

function memoryWorkerEntrypoint(sourceWorkerName: string, distWorkerName: string) {
  return {
    currentModuleUrl: import.meta.url,
    sourceWorkerName,
    distWorkerPath: `extensions/memory-core/${distWorkerName}.js`,
    package: {
      name: "@openclaw/memory-core",
      distWorkerPath: path.posix.join("src/memory", `${sourceWorkerName}.js`),
    },
  } as const;
}

export const memoryCpuProcessEntrypoints = {
  search: memoryWorkerEntrypoint("manager-search.worker", "memory-search.worker"),
  index: memoryWorkerEntrypoint("manager-index.worker", "memory-index.worker"),
  publication: memoryWorkerEntrypoint("manager-publication.worker", "memory-publication.worker"),
  standingIntents: memoryWorkerEntrypoint("../standing-intents.worker", "standing-intents.worker"),
  entryOrigins: memoryWorkerEntrypoint(
    "../memory-entry-origins.worker",
    "memory-entry-origins.worker",
  ),
} as const;
