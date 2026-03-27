import {
  createBrowserPluginService,
  createBrowserTool,
  definePluginEntry,
  handleBrowserGatewayRequest,
  registerBrowserCli,
  type OpenClawPluginToolContext,
  type OpenClawPluginToolFactory,
} from "./runtime-api.js";

export default definePluginEntry({
  id: "browser",
  name: "Browser",
  description: "Default browser tool plugin",
  register(api) {
    api.registerTool(((ctx: OpenClawPluginToolContext) =>
      createBrowserTool({
        sandboxBridgeUrl: ctx.browser?.sandboxBridgeUrl,
        allowHostControl: ctx.browser?.allowHostControl,
        agentSessionKey: ctx.sessionKey,
      })) as OpenClawPluginToolFactory);
    api.registerCli(({ program }) => registerBrowserCli(program), { commands: ["browser"] });
    api.registerGatewayMethod("browser.request", handleBrowserGatewayRequest, {
      scope: "operator.admin",
    });
    api.registerService(createBrowserPluginService());
  },
});
