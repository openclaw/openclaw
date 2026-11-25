import { pluginRuntimeProcessManifest } from "../../src/infra/runtime-process-manifest.ts";
import {
  createRuntimeProcessBuildEntries,
  runtimeProcessCoreEntrypoints,
} from "./runtime-process-core-build-entries.mts";

const pluginBuildEntrypoints = Object.values(pluginRuntimeProcessManifest).flatMap((entry) => {
  if ("build" in entry) {
    return [];
  }
  return [
    Object.assign({}, entry, {
      currentModuleUrl: new URL(`../../${entry.ownerSource}`, import.meta.url).href,
    }),
  ];
});

// The private test graph covers package-owned workers as well as the host runtime.
export const runtimeProcessBuildEntrypoints = [
  ...runtimeProcessCoreEntrypoints,
  ...pluginBuildEntrypoints,
];
export const runtimeProcessBuildEntries = createRuntimeProcessBuildEntries(
  runtimeProcessBuildEntrypoints,
);

/** Package-owned plugin workers remain in their isolated package build. */
export function createRootRuntimeProcessBuildEntries(pluginIds: readonly string[]) {
  const selected = new Set(pluginIds);
  return createRuntimeProcessBuildEntries([
    ...runtimeProcessCoreEntrypoints,
    ...pluginBuildEntrypoints.filter((entry) => selected.has(entry.plugin)),
  ]);
}
