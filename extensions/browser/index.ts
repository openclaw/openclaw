import {
	createBrowserPluginService,
	createBrowserTool,
	definePluginEntry,
	handleBrowserGatewayRequest,
	type OpenClawPluginToolContext,
	type OpenClawPluginToolFactory,
	registerBrowserCli,
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
		api.registerCli(({ program }) => registerBrowserCli(program), {
			commands: ["browser"],
		});
		api.registerGatewayMethod("browser.request", handleBrowserGatewayRequest, {
			scope: "operator.write",
		});
		api.registerService(createBrowserPluginService());
	},
});
