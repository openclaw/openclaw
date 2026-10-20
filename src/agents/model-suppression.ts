import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildManifestBuiltInModelSuppressionResolver } from "../plugins/manifest-model-suppression.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";

export function resolveBuiltInModelSuppressionFromManifest(params: {
  provider?: string | null;
  id?: string | null;
  baseUrl?: string | null;
  config?: OpenClawConfig;
  unconditionalOnly?: boolean;
  workspaceDir?: string;
  metadataSnapshot?: PluginMetadataSnapshot;
}) {
  return buildManifestBuiltInModelSuppressionResolver({
    env: process.env,
    config: params.config,
    workspaceDir: params.workspaceDir,
    metadataSnapshot: params.metadataSnapshot,
  })(params);
}

/**
 * Return true only for unconditional manifest suppressions.
 * Inline model entries may override conditional suppressions, but not absolute
 * provider capability blocks.
 */
export function shouldUnconditionallySuppress(params: {
  provider?: string | null;
  id?: string | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
}): boolean {
  return (
    resolveBuiltInModelSuppressionFromManifest({ ...params, unconditionalOnly: true })?.suppress ??
    false
  );
}

export function buildSuppressedBuiltInModelError(params: {
  provider?: string | null;
  id?: string | null;
  baseUrl?: string | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
}): string | undefined {
  return resolveBuiltInModelSuppressionFromManifest(params)?.errorMessage;
}

export function buildShouldSuppressBuiltInModelCore(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
}): (input: { provider?: string | null; id?: string | null; baseUrl?: string | null }) => boolean {
  const resolver = buildManifestBuiltInModelSuppressionResolver({
    env: process.env,
    ...params,
  });
  return (input) => resolver(input)?.suppress ?? false;
}
