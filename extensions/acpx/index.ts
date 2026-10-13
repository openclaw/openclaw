/**
 * ACPX runtime plugin entry. It registers the embedded ACP backend service and
 * wires reply-dispatch hooks into the plugin SDK runtime.
 */
import { createAgentRegistry } from "acpx/agent-registry";
import { tryDispatchAcpReplyHook } from "openclaw/plugin-sdk/acp-runtime-backend";
import { createAcpxRuntimeService } from "./register.runtime.js";
import type { OpenClawPluginApi } from "./runtime-api.js";
import { ACPX_NATIVE_AGENT_IDS } from "./src/config-schema.js";
import { createAcpAgentHarness } from "./src/harness.js";
import { isAcpxNativeAgentEnabled, listAcpxNativeAgents } from "./src/native-agents.js";
import { registerPiSessionCatalog } from "./src/pi-session-catalog-plugin.js";

const plugin = {
  id: "acpx",
  name: "ACPX Runtime",
  description: "Embedded ACP runtime backend with plugin-owned session and transport management.",
  register(api: OpenClawPluginApi) {
    registerPiSessionCatalog(api);
    const service = createAcpxRuntimeService({
      pluginConfig: api.pluginConfig,
      getAllowedAgents: () => api.runtime.config.current().acp?.allowedAgents,
      openKeyedStore: (options) => api.runtime.state.openKeyedStore(options),
    });
    api.registerService(service);
    const currentConfig = () => api.runtime.config.current().plugins?.entries?.acpx?.config;
    const registry = createAgentRegistry();
    const nativeAgents = ACPX_NATIVE_AGENT_IDS.map((agentId) => {
      const agent = registry.inspect(agentId);
      if (!agent) {
        throw new Error(`Unknown ACP harness: ${agentId}`);
      }
      api.registerAgentHarness(
        createAcpAgentHarness({
          agent: agentId,
          label: agent.name,
          isEnabled: () => isAcpxNativeAgentEnabled(currentConfig()?.nativeAgents, agentId),
          api,
          getRuntime: service.getRuntime,
          shutdown: () =>
            service.stop?.({
              config: api.config,
              stateDir: api.runtime.state.resolveStateDir(),
              logger: api.logger,
            }),
        }),
      );
      return { id: agentId, name: agent.name, runtimeId: `acp-${agentId}` };
    });
    api.registerReload({ noopPrefixes: ["plugins.entries.acpx.config.nativeAgents"] });
    api.registerGatewayMethod(
      "acpx.agents.list",
      ({ params, respond }) => {
        if (Object.keys(params).length > 0) {
          respond(false, undefined, {
            code: "INVALID_REQUEST",
            message: "acpx.agents.list takes no parameters",
          });
          return;
        }
        respond(true, { agents: listAcpxNativeAgents(currentConfig(), nativeAgents) }, undefined);
      },
      { scope: "operator.read", profileAccess: "independent" },
    );
    api.on("reply_dispatch", tryDispatchAcpReplyHook, { eligibleDispatchKinds: ["acp"] });
  },
};

export default plugin;
