import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ImageCompressionModelPolicy } from "../media/web-media.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";

/** Resolves the authoritative image limits for one selected provider/model. */
export async function resolveImageCompressionModelPolicy(params: {
  cfg?: OpenClawConfig;
  provider: string;
  model: string;
  agentDir?: string;
  workspaceDir?: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  abortSignal?: AbortSignal;
}): Promise<ImageCompressionModelPolicy> {
  async function resolvePolicyWithHooks(
    skipProviderRuntimeHooks: boolean,
  ): Promise<ImageCompressionModelPolicy> {
    try {
      const { resolveModelAsync } = await import("./embedded-agent-runner/model.js");
      const resolved = await resolveModelAsync(
        params.provider,
        params.model,
        params.agentDir,
        params.cfg,
        {
          abortSignal: params.abortSignal,
          allowBundledStaticCatalogFallback: true,
          skipProviderRuntimeHooks,
          skipAgentDiscovery: true,
          workspaceDir: params.workspaceDir,
          ...(params.preparedModelRuntime
            ? { preparedModelRuntime: params.preparedModelRuntime }
            : {}),
        },
      );
      // SAFETY: model resolution preserves provider runtime fields on its narrower Model result.
      return (resolved.model as ProviderRuntimeModel | undefined)?.mediaInput?.image ?? {};
    } catch {
      params.abortSignal?.throwIfAborted();
      return {};
    }
  }

  const staticPolicy = await resolvePolicyWithHooks(true);
  if (typeof staticPolicy.maxSidePx === "number" || typeof staticPolicy.maxPixels === "number") {
    return staticPolicy;
  }
  // Explicit static limits win; the selected provider's hooks supply missing limits.
  return { ...(await resolvePolicyWithHooks(false)), ...staticPolicy };
}
