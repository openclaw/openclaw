import { fileURLToPath } from "node:url";
import { runtimeProcessEntrypoints } from "../../src/infra/runtime-process-entrypoints.ts";
import {
  pluginRuntimeProcessManifest,
  runtimeProcessScriptEntrypoints,
} from "../../src/infra/runtime-process-manifest.ts";
import { managedMemoryEntrypoint } from "./managed-memory-entrypoint.mts";
import { managedWindowsJobEntrypoint } from "./managed-windows-job-entrypoint.mts";

export function createRuntimeProcessBuildEntries(
  entries: readonly {
    currentModuleUrl: string;
    sourceWorkerName: string;
    distWorkerPath: string;
    sourceExtension?: ".ts" | ".mts" | ".mjs";
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
  // Recovery artifacts are built by the sealed handoff owner, never the shared graph.
  ...Object.values(runtimeProcessEntrypoints).filter((entry) =>
    entry.distWorkerPath.endsWith(".js"),
  ),
  managedWindowsJobEntrypoint,
  managedMemoryEntrypoint,
];

const privateChunkRuntimeProcessEntrypoints = [
  runtimeProcessEntrypoints.cronReadOnly,
  runtimeProcessEntrypoints.stateLeaseHeartbeat,
  runtimeProcessEntrypoints.sessionDiskBudget,
  runtimeProcessEntrypoints.pluginModelCatalogRead,
  runtimeProcessEntrypoints.attachmentProcessor,
  runtimeProcessEntrypoints.widgetScriptSyntax,
  runtimeProcessEntrypoints.codeModeNode,
  runtimeProcessEntrypoints.imageProcessor,
  runtimeProcessEntrypoints.identityFile,
  runtimeProcessEntrypoints.localAgentAvatar,
  runtimeProcessEntrypoints.fsSafeCopy,
  runtimeProcessEntrypoints.execRealpath,
  runtimeProcessEntrypoints.secretFileRead,
  runtimeProcessEntrypoints.fileLog,
  runtimeProcessEntrypoints.serviceChildGroupAnchor,
  runtimeProcessEntrypoints.controlUiFile,
  runtimeProcessEntrypoints.publicSessionCard,
  runtimeProcessEntrypoints.sessionTranscriptReconcile,
  runtimeProcessEntrypoints.gitOperations,
  runtimeProcessEntrypoints.cronStreamMatcher,
  runtimeProcessEntrypoints.fileToolPlanning,
  {
    ...pluginRuntimeProcessManifest.codexCatalogPage,
    currentModuleUrl: new URL(
      `../../${pluginRuntimeProcessManifest.codexCatalogPage.ownerSource}`,
      import.meta.url,
    ).href,
  },
];

// Keep small helper processes out of the shared runtime bundle.
export const standaloneRuntimeProcessBuildEntries = createRuntimeProcessBuildEntries([
  managedMemoryEntrypoint,
  ...Object.values(runtimeProcessScriptEntrypoints).flatMap((entry) =>
    "runtimeEntrypoint" in entry ? [runtimeProcessEntrypoints[entry.runtimeEntrypoint]] : [],
  ),
  runtimeProcessEntrypoints.pluginGenerationPreparation,
  runtimeProcessEntrypoints.sqliteReadOnly,
  runtimeProcessEntrypoints.sqliteSourceRevision,
  runtimeProcessEntrypoints.stateRead,
  runtimeProcessEntrypoints.sessionTranscript,
  runtimeProcessEntrypoints.sharedWorkerHost,
  ...privateChunkRuntimeProcessEntrypoints,
  runtimeProcessEntrypoints.shellSnapshotEnvironment,
  runtimeProcessEntrypoints.nativeHookRelayClient,
  runtimeProcessEntrypoints.spawnBroker,
  runtimeProcessEntrypoints.gatewayStateOwnerHeartbeat,
  runtimeProcessEntrypoints.serviceChildRelay,
]);

export function getStandaloneRuntimeProcessOutputOptions(name: string) {
  if (
    privateChunkRuntimeProcessEntrypoints.some(
      (entry) => entry.distWorkerPath.replace(/\.js$/u, "") === name,
    )
  ) {
    // Small workers must not evaluate shared Gateway chunks; keep optional paths lazy.
    return { codeSplitting: true, chunkFileNames: `${name}-[name]-[hash].mjs` };
  }
  const pluginPreparationEntry =
    runtimeProcessEntrypoints.pluginGenerationPreparation.distWorkerPath.replace(/\.js$/u, "");
  // Keep optional read handlers lazy without sharing the main runtime graph.
  const sqliteReadEntry = runtimeProcessEntrypoints.sqliteReadOnly.distWorkerPath.replace(
    /\.js$/u,
    "",
  );
  if (name === pluginPreparationEntry) {
    // Each retained plugin has its own worker. Shared gateway chunks multiply
    // their resident cost; keep diagnostics lazy inside this private graph.
    return { codeSplitting: true, chunkFileNames: "plugins/plugin-preparation-[name]-[hash].mjs" };
  }
  if (name === sqliteReadEntry) {
    return { codeSplitting: true, chunkFileNames: "infra/sqlite-readonly-[name]-[hash].mjs" };
  }
  if (sharedWorkerHostGraph.has(name)) {
    // Lean hosts these core modules in one isolate; they must load one shared graph.
    return { codeSplitting: true, chunkFileNames: "infra/shared-worker-host-[name]-[hash].mjs" };
  }
  return { codeSplitting: false };
}

// The shared host imports the state reader and transcript worker. One build emits their
// common modules once instead of a private copy per worker (#202495 added ~540 files).
const sharedWorkerHostGraph = new Set(
  [
    runtimeProcessEntrypoints.sharedWorkerHost,
    runtimeProcessEntrypoints.stateRead,
    runtimeProcessEntrypoints.sessionTranscript,
  ].map((entry) => entry.distWorkerPath.replace(/\.js$/u, "")),
);

/** Standalone entries, one record per build; the shared host graph builds together. */
export function standaloneRuntimeProcessBuildGroups(entries: Record<string, string>) {
  const standalone = Object.entries(entries).filter(([name]) =>
    Object.hasOwn(standaloneRuntimeProcessBuildEntries, name),
  );
  const hosted = standalone.filter(([name]) => sharedWorkerHostGraph.has(name));
  return [
    ...(hosted.length ? [Object.fromEntries(hosted)] : []),
    ...standalone
      .filter(([name]) => !sharedWorkerHostGraph.has(name))
      .map((entry) => Object.fromEntries([entry])),
  ];
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
