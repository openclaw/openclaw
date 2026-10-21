import path from "node:path";
import { fileURLToPath } from "node:url";
import type { UserConfig } from "tsdown";
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

// Keep process-owned graphs out of the shared runtime bundle.
export const standaloneRuntimeProcessBuildEntries = createRuntimeProcessBuildEntries([
  managedMemoryEntrypoint,
  runtimeProcessEntrypoints.sqliteReadOnly,
  runtimeProcessEntrypoints.sqliteSourceRevision,
  runtimeProcessEntrypoints.stateRead,
  runtimeProcessEntrypoints.sessionTranscript,
  runtimeProcessEntrypoints.nativeHookRelayClient,
  runtimeProcessEntrypoints.spawnBroker,
  runtimeProcessEntrypoints.stateLeaseHeartbeat,
  runtimeProcessEntrypoints.serviceChildRelay,
  runtimeProcessEntrypoints.serviceChildGroupAnchor,
]);

export function standaloneRuntimeProcessBuildOutputOptions(
  name: string,
  source: string,
): NonNullable<UserConfig["outputOptions"]> {
  const sessionTranscriptEntry = runtimeProcessEntrypoints.sessionTranscript.distWorkerPath.replace(
    /\.js$/u,
    "",
  );
  if (name !== sessionTranscriptEntry) {
    return { codeSplitting: false };
  }
  const workerSource = path.resolve(source);
  return {
    // Root-level private chunks preserve metadata lookup depth and avoid sharing
    // this worker's runtime modules with Gateway/SDK output graphs.
    chunkFileNames: "session-transcript-[name]-[hash].mjs",
    codeSplitting: {
      groups: [
        {
          name: "initial",
          // Coalesce the existing static startup chain; other request paths stay
          // split. Keep the public nested worker facade outside the root chunk.
          tags: ["$initial"],
          test: (id: string) => id !== workerSource,
        },
      ],
    },
  };
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
