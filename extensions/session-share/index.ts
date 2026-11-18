import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerSessionShareGatewayMethods } from "./src/gateway-methods.js";
import { createSessionShareNodeCommands, SESSION_SHARE_COMMANDS } from "./src/node-commands.js";
import { createSessionShareCatalog } from "./src/session-catalog.js";

export default definePluginEntry({
  id: "session-share",
  name: "Session Share",
  description: "Read-only OpenClaw sessions on paired gateways",
  register(api) {
    registerSessionShareGatewayMethods(api);
    api.registerSessionCatalog(createSessionShareCatalog(api));
    for (const command of createSessionShareNodeCommands(api)) {
      api.registerNodeHostCommand(command);
    }
    api.registerNodeInvokePolicy({
      commands: SESSION_SHARE_COMMANDS,
      defaultPlatforms: ["macos", "linux", "windows"],
      handle: (context) => context.invokeNode(),
    });
  },
});
