import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeWebToolsMetadata } from "../secrets/runtime-web-tools.types.js";
import { hasConfiguredWebSearchProvider } from "../web-search/runtime.js";
import { resolveAgentDir } from "./agent-scope.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import { createWebFetchTool, createWebSearchTool } from "./tools/web-tools.js";

export function createOpenClawWebTools(params: {
  options?: OpenClawToolsOptions;
  sessionAgentId: string;
  resolvedConfig?: OpenClawConfig;
  availabilityConfig?: OpenClawConfig;
  runtimeWebTools: RuntimeWebToolsMetadata | null;
  preparedWebSearchConfigured?: boolean;
}) {
  const { options, sessionAgentId, resolvedConfig, availabilityConfig, runtimeWebTools } = params;
  const webSearchAgentDir =
    options?.agentDir ?? resolveAgentDir(resolvedConfig ?? {}, sessionAgentId);
  let webSearchTool = createWebSearchTool({
    ...options,
    agentDir: webSearchAgentDir,
    enabled: options?.webSearchEnabled,
    runtimeWebSearch: runtimeWebTools?.search,
    lateBindRuntimeConfig: true,
  });
  if (webSearchTool) {
    const configured =
      params.preparedWebSearchConfigured ??
      hasConfiguredWebSearchProvider({
        config: availabilityConfig ?? resolvedConfig,
        agentDir: webSearchAgentDir,
        authStore: options?.authProfileStore,
        runtimeWebSearch: runtimeWebTools?.search,
        ...(options?.authProfileStoreSource !== undefined
          ? { resolveAuthProfileStoreSource: () => options.authProfileStoreSource === true }
          : {}),
      });
    options?.onWebSearchConfiguration?.(configured);
    if (!configured) {
      webSearchTool = null;
    }
  }
  options?.recordToolPrepStage?.("openclaw-tools:web-search-tool");
  const webFetchTool = createWebFetchTool({
    ...options,
    agentId: sessionAgentId,
    runtimeWebFetch: runtimeWebTools?.fetch,
    lateBindRuntimeConfig: true,
    hostnameAllowlistRef: options?.webFetchHostnameAllowlistRef,
  });
  options?.recordToolPrepStage?.("openclaw-tools:web-fetch-tool");
  return { webSearchTool, webFetchTool };
}
