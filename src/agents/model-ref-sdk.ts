import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadLegacyPluginMetadataSnapshotRuntime } from "../plugins/plugin-metadata-snapshot-required.js";
import { getActivePluginRegistryWorkspaceDirFromStateCore } from "../plugins/runtime-workspace-state.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import type {
  ModelManifestNormalizationContext,
  ModelRef,
  ModelRefNormalizeOptions,
} from "./model-ref-shared.js";
import { parseModelRef as parseModelRefCore } from "./model-selection-normalize.js";
import type { resolveModelRefFromString } from "./model-selection-shared.js";

export type ModelRefPreparationOptions = ModelManifestNormalizationContext & {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
};

export type ParseModelRefAsyncOptions = ModelRefPreparationOptions & ModelRefNormalizeOptions;

export type PreparedModelRefResolver = {
  readonly manifestPlugins: NonNullable<ModelManifestNormalizationContext["manifestPlugins"]>;
  parseModelRef: (
    raw: string,
    defaultProvider: string,
    options?: Omit<ModelRefNormalizeOptions, "manifestPlugins">,
  ) => ModelRef | null;
  resolveModelRefFromString: typeof resolveModelRefFromString;
};

/** Captures one metadata selection for repeated synchronous model-ref parsing. */
export async function prepareModelRefResolver(
  options: ModelRefPreparationOptions = {},
): Promise<PreparedModelRefResolver> {
  let manifestPlugins = options.manifestPlugins;
  if (!manifestPlugins) {
    const { resolvePluginMetadataSnapshotAsync } =
      await import("../plugins/plugin-metadata-snapshot.js");
    manifestPlugins = await resolvePluginMetadataSnapshotAsync({
      config: options.config,
      env: options.env,
      workspaceDir: options.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromStateCore(),
      allowWorkspaceScopedCurrent: true,
    });
  }
  const { resolveModelRefFromString: resolve } = await import("./model-selection-shared.js");
  return {
    manifestPlugins,
    parseModelRef: (raw, defaultProvider, normalizeOptions) =>
      parseModelRefCore(raw, defaultProvider, { ...normalizeOptions, manifestPlugins }),
    resolveModelRefFromString: (params) => resolve({ ...params, manifestPlugins }),
  };
}

/** Prepares manifest aliases through the existing metadata worker before parsing. */
export async function parseModelRefAsync(
  raw: string,
  defaultProvider: string,
  options: ParseModelRefAsyncOptions = {},
): Promise<ModelRef | null> {
  if (options.allowManifestNormalization === false || options.manifestPlugins) {
    return parseModelRefCore(raw, defaultProvider, options);
  }
  const resolver = await prepareModelRefResolver(options);
  return resolver.parseModelRef(raw, defaultProvider, options);
}

/** @deprecated Await parseModelRefAsync or prepareModelRefResolver; removed in a later release after stable deprecation. */
export function parseModelRefLegacy(
  raw: string,
  defaultProvider: string,
  options?: ModelRefNormalizeOptions,
): ModelRef | null {
  warnPluginSdkDeprecation({
    family: "model-ref-sync-discovery",
    method: "parseModelRef",
    replacement: "parseModelRefAsync or prepareModelRefResolver",
    compatibility: "The synchronous parser retains cold manifest alias discovery.",
  });
  if (options?.manifestPlugins || options?.allowManifestNormalization === false || !raw.trim()) {
    return parseModelRefCore(raw, defaultProvider, options);
  }
  const manifestPlugins = loadLegacyPluginMetadataSnapshotRuntime({
    env: process.env,
    workspaceDir: getActivePluginRegistryWorkspaceDirFromStateCore(),
    allowWorkspaceScopedCurrent: true,
  });
  return parseModelRefCore(raw, defaultProvider, { ...options, manifestPlugins });
}
