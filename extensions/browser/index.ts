import {
  definePluginEntry,
  type MullusiPluginToolContext,
  type MullusiPluginToolFactory,
} from "mullusi/plugin-sdk/plugin-entry";
import {
  createBrowserPluginService,
  createBrowserTool,
  handleBrowserGatewayRequest,
  registerBrowserCli,
} from "./register.runtime.js";

export default definePluginEntry({
  id: "browser",
  name: "Browser",
  description: "Default browser tool plugin",
  register(api) {
    api.registerTool(((ctx: MullusiPluginToolContext) =>
      createBrowserTool({
        sandboxBridgeUrl: ctx.browser?.sandboxBridgeUrl,
        allowHostControl: ctx.browser?.allowHostControl,
        agentSessionKey: ctx.sessionKey,
      })) as MullusiPluginToolFactory);
    api.registerCli(({ program }) => registerBrowserCli(program), { commands: ["browser"] });
    api.registerGatewayMethod("browser.request", handleBrowserGatewayRequest, {
      scope: "operator.write",
    });
    api.registerService(createBrowserPluginService());
  },
});
