import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withSqliteReadOnlyWorkerScope } from "../../infra/sqlite-readonly-worker.js";
import type { AuthProfileCredential } from "../auth-profiles/types.js";
import type { ModelFallbackRouteResolution } from "../model-fallback.types.js";
import {
  prepareModelRuntimeSnapshot,
  type PreparedModelRuntimeSnapshot,
} from "../prepared-model-runtime.js";
import { resolveModelAsync } from "./model.js";

type ModelResolution = Awaited<ReturnType<typeof resolveModelAsync>>;

/** Resolves embedded-run models through discovery first, then the prepared static catalog. */
export async function resolveTieredModel(params: {
  abortSignal?: AbortSignal;
  assertCurrent?: () => void;
  provider: string;
  modelId: string;
  requestedRouteResolution?: ModelFallbackRouteResolution;
  agentDir: string;
  config?: OpenClawConfig;
  workspaceDir: string;
  authProfileId?: string;
  authProfileMode?: AuthProfileCredential["type"] | "aws-sdk";
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  staticCatalogOwnsTransport?: boolean;
}): Promise<{ provider: string; resolution: ModelResolution }> {
  const result = await withSqliteReadOnlyWorkerScope(async () => {
    const resolve = async (options: Parameters<typeof resolveModelAsync>[4]) => {
      const modelOptions: Parameters<typeof resolveModelAsync>[4] = {
        ...options,
        abortSignal: params.abortSignal,
        assertCurrent: params.assertCurrent,
        workspaceDir: params.workspaceDir,
        authProfileId: params.authProfileId,
        authProfileMode: params.authProfileMode,
        modelIdSource: params.requestedRouteResolution === "resolved" ? "selected" : "input",
      };
      const resolution = await resolveModelAsync(
        params.provider,
        params.modelId,
        params.agentDir,
        params.config,
        modelOptions,
      );
      return {
        provider: resolution.model ? resolution.logicalRef.provider : params.provider,
        resolution,
      };
    };
    const firstTier = await resolve({
      skipAgentDiscovery: true,
      allowBundledStaticCatalogFallback: params.staticCatalogOwnsTransport,
      preferBundledStaticCatalogTransport: params.staticCatalogOwnsTransport,
      preparedModelRuntime: params.preparedModelRuntime,
    });
    if (firstTier.resolution.model || params.staticCatalogOwnsTransport) {
      return firstTier;
    }
    const config = params.config ?? {};
    const preparedModelRuntime =
      params.preparedModelRuntime ??
      (await prepareModelRuntimeSnapshot({
        config,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
      }));
    // The prepared tier owns the final failure; an earlier discovery miss lacks
    // the route metadata needed to explain a provider-declared retirement.
    return await resolve({
      ...preparedModelRuntime.createStores(),
      allowBundledStaticCatalogFallback: true,
      preparedModelRuntime,
    });
  });
  params.abortSignal?.throwIfAborted();
  params.assertCurrent?.();
  return result;
}
