// Keep configured-model resolution off the focused parser's eager import graph.
import { loadLegacyPluginMetadataSnapshotRuntime } from "../plugins/plugin-metadata-snapshot-required.js";
import { getActivePluginRegistryWorkspaceDirFromStateCore } from "../plugins/runtime-workspace-state.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import { resolveModelRefFromString as resolveModelRefFromStringCore } from "./model-selection-shared.js";

/** @deprecated Await prepareModelRefResolver and use its resolver; removed in a later release after stable deprecation. */
export function resolveModelRefFromStringLegacy(
  params: Parameters<typeof resolveModelRefFromStringCore>[0],
): ReturnType<typeof resolveModelRefFromStringCore> {
  warnPluginSdkDeprecation({
    family: "model-ref-sync-discovery",
    method: "resolveModelRefFromString",
    replacement: "prepareModelRefResolver(...).resolveModelRefFromString",
    compatibility: "The synchronous resolver retains cold manifest alias discovery.",
  });
  if (params.manifestPlugins || params.allowManifestNormalization === false || !params.raw.trim()) {
    return resolveModelRefFromStringCore(params);
  }
  const manifestPlugins = loadLegacyPluginMetadataSnapshotRuntime({
    config: params.cfg,
    env: process.env,
    workspaceDir: getActivePluginRegistryWorkspaceDirFromStateCore(),
    allowWorkspaceScopedCurrent: true,
  });
  return resolveModelRefFromStringCore({ ...params, manifestPlugins });
}
