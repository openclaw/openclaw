import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { mcpRelayConfigSchema, parseMcpRelayConfig } from "./src/config.js";
import {
  registerMcpRelayGatewayMethods,
  registerMcpRelayConnectRoute,
} from "./src/gateway-methods.js";
import type { RelayService } from "./src/service.js";

export default definePluginEntry({
  id: "mcp-relay",
  name: "MCP Relay",
  description: "Connect remote MCP clients to this Gateway through an outbound relay",
  configSchema: mcpRelayConfigSchema,
  register(api) {
    let service: RelayService | undefined;
    api.registerCli(
      async (context) => {
        const { registerMcpRelayCli } = await import("./src/cli.js");
        await registerMcpRelayCli(context);
      },
      {
        descriptors: [
          {
            name: "mcp-relay",
            description: "Inspect the MCP relay connection and manage client grants",
            hasSubcommands: true,
          },
        ],
      },
    );
    registerMcpRelayGatewayMethods(api, () => service);
    registerMcpRelayConnectRoute(api, parseMcpRelayConfig(api.pluginConfig).relayUrl);
    api.session.controls.registerControlUiDescriptor({
      surface: "tab",
      id: "connected-apps",
      slug: "connected-apps",
      label: "Connected apps",
      icon: "plug",
      group: "control",
      requiredScopes: ["operator.read"],
    });
    api.registerService({
      id: "mcp-relay",
      apiVersion: 2,
      async start(context) {
        const { RelayState } = await import("./src/state.js");
        const { RelayService: Service } = await import("./src/service.js");
        const { createOperations } = await import("./src/operations.js");
        const config = parseMcpRelayConfig(api.pluginConfig);
        const scheduler = context.scheduler;
        const state = new RelayState(api.runtime, config.relayUrl, () =>
          scheduler.signal.throwIfAborted(),
        );
        const identity = await state.initialize();
        scheduler.signal.throwIfAborted();
        const gateway = { name: "OpenClaw", version: api.runtime.version };
        service = new Service({
          scheduler,
          state,
          identity,
          relayUrl: config.relayUrl,
          gateway,
          controlUiIngress: context.controlUiIngress,
          config: () => api.runtime.config.current(),
          operations: createOperations({
            logger: api.logger,
            gateway,
            agentId: config.agentId,
          }),
        });
        service.start();
      },
      async stop() {
        const active = service;
        service = undefined;
        await active?.stop();
      },
    });
  },
});
