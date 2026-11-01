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
  runtimeProcessEntrypoints.sessionDiskBudget,
  runtimeProcessEntrypoints.pluginModelCatalogRead,
  runtimeProcessEntrypoints.attachmentProcessor,
  runtimeProcessEntrypoints.widgetScriptSyntax,
  runtimeProcessEntrypoints.codeModeNode,
  runtimeProcessEntrypoints.imageProcessor,
  runtimeProcessEntrypoints.identityFile,
  runtimeProcessEntrypoints.localAgentAvatar,
  runtimeProcessEntrypoints.fsSafeCopy,
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
  ...privateChunkRuntimeProcessEntrypoints,
  runtimeProcessEntrypoints.shellSnapshotEnvironment,
  runtimeProcessEntrypoints.nativeHookRelayClient,
  runtimeProcessEntrypoints.spawnBroker,
  runtimeProcessEntrypoints.stateLeaseHeartbeat,
  runtimeProcessEntrypoints.gatewayStateOwnerHeartbeat,
  runtimeProcessEntrypoints.serviceChildRelay,
  runtimeProcessEntrypoints.serviceChildGroupAnchor,
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
  if (name === runtimeProcessEntrypoints.sessionTranscript.distWorkerPath.replace(/\.js$/u, "")) {
    return { codeSplitting: true, chunkFileNames: "config/sessions/transcript-[name]-[hash].mjs" };
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
