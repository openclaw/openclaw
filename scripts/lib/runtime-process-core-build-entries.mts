import { fileURLToPath } from "node:url";
import { runtimeProcessEntrypoints } from "../../src/infra/runtime-process-entrypoints.ts";
import {
  pluginRuntimeProcessManifest,
  runtimeProcessScriptEntrypoints,
} from "../../src/infra/runtime-process-manifest.ts";
import { groupBy } from "./group-by.mts";
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
  runtimeProcessEntrypoints.spawnBroker,
  {
    ...pluginRuntimeProcessManifest.codexCatalogPage,
    currentModuleUrl: new URL(
      `../../${pluginRuntimeProcessManifest.codexCatalogPage.ownerSource}`,
      import.meta.url,
    ).href,
  },
];

// Keep small helper processes out of the shared runtime bundle.
const individualRuntimeProcessBuildEntries = createRuntimeProcessBuildEntries([
  managedMemoryEntrypoint,
  ...Object.values(runtimeProcessScriptEntrypoints).flatMap((entry) =>
    "runtimeEntrypoint" in entry ? [runtimeProcessEntrypoints[entry.runtimeEntrypoint]] : [],
  ),
  runtimeProcessEntrypoints.pluginGenerationPreparation,
  runtimeProcessEntrypoints.sqliteReadOnly,
  runtimeProcessEntrypoints.sqliteSourceRevision,
  ...privateChunkRuntimeProcessEntrypoints,
  runtimeProcessEntrypoints.shellSnapshotEnvironment,
  runtimeProcessEntrypoints.nativeHookRelayClient,
  runtimeProcessEntrypoints.gatewayStateOwnerHeartbeat,
  runtimeProcessEntrypoints.serviceChildRelay,
]);

// The shared host imports both workers in one isolate. Building them together avoids
// shipping a copy of their common modules per worker.
const sharedWorkerHostBuildEntries = createRuntimeProcessBuildEntries([
  runtimeProcessEntrypoints.sharedWorkerHost,
  runtimeProcessEntrypoints.stateRead,
  runtimeProcessEntrypoints.sessionTranscript,
]);

// Both resources attach inside the broker isolate. One private graph keeps their
// module identities intact without loading shared Gateway chunks with the first claim.
export const brokerNativeResourceBuildEntries = createRuntimeProcessBuildEntries([
  runtimeProcessEntrypoints.pluginCaptureNativeResource,
  runtimeProcessEntrypoints.sqliteReadOnlyNativeResource,
]);

export const standaloneRuntimeProcessBuildEntries = {
  ...individualRuntimeProcessBuildEntries,
  ...sharedWorkerHostBuildEntries,
  ...brokerNativeResourceBuildEntries,
};

const sharedBuildGroups = [
  {
    entries: sharedWorkerHostBuildEntries,
    chunkFileNames: "infra/shared-worker-host-[name]-[hash].mjs",
  },
  {
    entries: brokerNativeResourceBuildEntries,
    chunkFileNames: "native-resource-private/[name]-[hash].mjs",
  },
];

function sharedBuildGroup(name: string) {
  return sharedBuildGroups.find(({ entries }) => Object.hasOwn(entries, name));
}

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
  const shared = sharedBuildGroup(name);
  if (shared) {
    return { codeSplitting: true, chunkFileNames: shared.chunkFileNames };
  }
  return { codeSplitting: false };
}

/** One build per isolated entry or group of entries hosted together. */
export function standaloneRuntimeProcessBuildGroups(entries: Record<string, string>) {
  const standalone = Object.entries(entries).filter(([name]) =>
    Object.hasOwn(standaloneRuntimeProcessBuildEntries, name),
  );
  return Array.from(
    groupBy(standalone, ([name]) => sharedBuildGroup(name) ?? name).values(),
    (group) => Object.fromEntries(group),
  );
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
