import { loadLegacyPluginMetadataSnapshotRuntime } from "../../plugins/plugin-metadata-snapshot-required.js";
import { getActivePluginRegistryWorkspaceDirFromStateCore } from "../../plugins/runtime-workspace-state.js";
import type { createExternalAuthRuntime, ExternalCliOverlayOptions } from "./external-auth.js";

/** Released synchronous auth-store APIs retain native metadata discovery. */
export function withLegacyExternalAuthPreparation(
  runtime: ReturnType<typeof createExternalAuthRuntime>,
): ReturnType<typeof createExternalAuthRuntime> {
  function prepare(options?: ExternalCliOverlayOptions & { env?: NodeJS.ProcessEnv }) {
    return {
      ...options,
      pluginMetadataSnapshot:
        options?.pluginMetadataSnapshot ??
        loadLegacyPluginMetadataSnapshotRuntime({
          config: options?.config,
          env: options?.env ?? process.env,
          workspaceDir: getActivePluginRegistryWorkspaceDirFromStateCore(),
          allowWorkspaceScopedCurrent: true,
        }),
    };
  }

  return {
    ...runtime,
    listRuntimeExternalAuthProfiles: (params) =>
      runtime.listRuntimeExternalAuthProfiles({
        ...params,
        externalCli: prepare({ ...params.externalCli, env: params.env }),
      }),
    overlayExternalAuthProfiles: (store, options) =>
      runtime.overlayExternalAuthProfiles(store, prepare(options)),
  };
}
