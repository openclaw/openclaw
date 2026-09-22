import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ImageCompressionModelPolicy } from "../media/web-media.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";

type ResolveModelAsync = (typeof import("./embedded-agent-runner/model.js"))["resolveModelAsync"];

const resolveModelAsyncDefault: ResolveModelAsync = async (...args) => {
  const { resolveModelAsync } = await import("./embedded-agent-runner/model.js");
  return await resolveModelAsync(...args);
};

/** Resolves the authoritative image limits for one selected provider/model. */
export async function resolveImageCompressionModelPolicy(params: {
  cfg?: OpenClawConfig;
  provider: string;
  model: string;
  agentDir?: string;
  workspaceDir?: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  deps?: { resolveModelAsync?: ResolveModelAsync };
}): Promise<ImageCompressionModelPolicy> {
  const resolveModelAsync = params.deps?.resolveModelAsync ?? resolveModelAsyncDefault;
  async function resolvePolicyWithHooks(
    skipProviderRuntimeHooks: boolean,
  ): Promise<ImageCompressionModelPolicy> {
    try {
      const resolved = await resolveModelAsync(
        params.provider,
        params.model,
        params.agentDir,
        params.cfg,
        {
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
