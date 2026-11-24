import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createSessionShareGatewayCatalog } from "./src/gateway-catalog.js";
import { registerSessionShareGatewayMethods } from "./src/gateway-methods.js";
import {
  createSessionShareNodeCommands,
  SESSION_SHARE_COMMANDS,
  SESSION_SHARE_CATALOG_COMMANDS,
} from "./src/node-commands.js";
import { createSessionShareCatalog } from "./src/session-catalog.js";

export default definePluginEntry({
  id: "session-share",
  name: "Session Share",
  description: "Read-only OpenClaw sessions on paired gateways",
  register(api) {
    registerSessionShareGatewayMethods(api);
    const nodes = createSessionShareCatalog(api);
    const gateways = createSessionShareGatewayCatalog(api);
    api.registerSessionCatalog({
      ...nodes,
      async list(query) {
        const [nodeHosts, gatewayHosts] = await Promise.all([
          nodes.list(query),
          gateways.list(query),
        ]);
        return [...nodeHosts, ...gatewayHosts];
      },
      read: (request) =>
        request.hostId.startsWith("gateway:") ? gateways.read(request) : nodes.read(request),
    });
    for (const command of createSessionShareNodeCommands(api)) {
      api.registerNodeHostCommand(command);
    }
    api.registerNodeInvokePolicy({
      commands: SESSION_SHARE_CATALOG_COMMANDS,
      handle: (context) => context.invokeNode(),
    });
    api.registerNodeInvokePolicy({
      commands: SESSION_SHARE_COMMANDS,
      defaultPlatforms: ["macos", "linux", "windows"],
      handle: (context) => context.invokeNode(),
    });
  },
});
