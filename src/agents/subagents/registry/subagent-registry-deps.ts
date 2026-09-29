import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ResolveContextEngineOptions } from "../../../context-engine/registry.js";
import type { callGateway } from "../../../gateway/call.js";
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

export const loadSubagentAnnounceModule = subagentAnnounceLoader.load;
export const loadSubagentBrowserCleanupModule = browserCleanupLoader.load;
export const callSubagentRegistryGateway: typeof callGateway = (request) =>
  bindGatewayLifecycleRequest()(request);

export async function loadSubagentRegistryPluginRuntimeHandle(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  allowGatewaySubagentBinding?: boolean;
}): Promise<PluginRegistry | undefined> {
  return (await subagentRegistryPluginRuntimeLoader.load()).loadAgentRuntimePluginRegistryHandle(
    params,
  );
}

export async function resolveSubagentRegistryContextEngine(
  cfg: OpenClawConfig,
  options?: ResolveContextEngineOptions,
) {
  const runtime = await subagentRegistryRuntimeLoader.load();
  runtime.ensureContextEnginesInitialized();
  return await runtime.resolveContextEngine(cfg, options);
}

export function resetSubagentRegistryRuntimeLoadersForTests() {
  subagentRegistryRuntimeLoader.clear();
  subagentRegistryPluginRuntimeLoader.clear();
  subagentAnnounceLoader.clear();
  browserCleanupLoader.clear();
}
