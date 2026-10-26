import type { AgentWaitParams } from "../../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ResolveContextEngineOptions } from "../../../context-engine/registry.js";
import type { callGateway } from "../../../gateway/call.js";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import { bindGatewayLifecycleRequest } from "../../../gateway/server-recovery-runtime-context.js";
import type { PluginRegistry } from "../../../plugins/registry-types.js";
import { createLazyImportLoader, createLazyPromiseLoader } from "../../../shared/lazy-promise.js";
import { importRuntimeModule } from "../../../shared/runtime-import.js";

const subagentAnnounceLoader = createLazyImportLoader(
  () => import("../announce/subagent-announce.js"),
);
const browserCleanupLoader = createLazyImportLoader(
  () => import("../../../browser-lifecycle-cleanup.js"),
);
const subagentRegistryRuntimeLoader = createLazyPromiseLoader(() =>
  importRuntimeModule<typeof import("./subagent-registry.runtime.js")>(import.meta.url, [
    "./subagent-registry.runtime",
    ".js",
  ]),
);
const subagentRegistryPluginRuntimeLoader = createLazyPromiseLoader(
  () => import("../../runtime-plugins.js"),
);
const preparedRuntimeLoader = createLazyPromiseLoader(
  () => import("../../prepared-model-runtime.js"),
);

export const loadSubagentAnnounceModule = subagentAnnounceLoader.load;
export const loadSubagentBrowserCleanupModule = browserCleanupLoader.load;
export const callSubagentRegistryGateway: typeof callGateway = (request) =>
  bindGatewayLifecycleRequest()(request);

export function createSubagentRegistryGatewayCaller(
  getGatewayContextResolver: () => GatewayContextResolver | undefined,
): typeof callGateway {
  return async <T>(request: Parameters<typeof callGateway>[0]) => {
    if (request.method === "agent.wait") {
      const gatewayRuntime = getGatewayContextResolver()?.()?.recoveryRuntime;
      if (gatewayRuntime) {
        // Registry waits are Gateway-owned lifecycle work. Keep them on the
        // owning instance when one exists; standalone processes authenticate normally.
        return await gatewayRuntime.waitForAgent<T>(
          // SAFETY: the instance-owned wait facade validates AgentWaitParams before execution.
          (request.params ?? {}) as AgentWaitParams,
          request.timeoutMs ?? undefined,
        );
      }
    }
    return await callSubagentRegistryGateway<T>(request);
  };
}

export async function loadSubagentRegistryPluginRuntimeHandle(params: {
  config: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  allowGatewaySubagentBinding?: boolean;
}): Promise<PluginRegistry | undefined> {
  if (params.allowGatewaySubagentBinding && params.agentDir) {
    const prepared = await preparedRuntimeLoader.load();
    const registry = prepared.getPreparedInboundPluginRegistry({
      ...params,
      agentDir: params.agentDir,
    });
    if (registry) {
      return registry;
    }
  }
  return (
    await subagentRegistryPluginRuntimeLoader.load()
  ).loadAgentRuntimePluginRegistryHandleAsync(params);
}

export async function resolveSubagentRegistryContextEngine(
  cfg: OpenClawConfig,
  options?: ResolveContextEngineOptions,
) {
  const runtime = await subagentRegistryRuntimeLoader.load();
  return await runtime.resolveContextEngine(cfg, {
    ...options,
    initialize: runtime.ensureContextEnginesInitialized,
  });
}
