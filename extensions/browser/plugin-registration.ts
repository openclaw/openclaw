import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  collectBrowserSecurityAuditFindings,
  createBrowserPluginService,
  createBrowserTool,
  handleBrowserGatewayRequest,
  registerBrowserCli,
  runBrowserProxyCommand,
} from "./register.runtime.js";

export const browserPluginReload = { restartPrefixes: ["browser"] } as const;

export const browserPluginNodeHostCommands = [
  {
    command: "browser.proxy",
    cap: "browser",
    handle: runBrowserProxyCommand,
  },
] as const;

export const browserSecurityAuditCollectors = [collectBrowserSecurityAuditFindings] as const;

export function registerBrowserPlugin(api: OpenClawPluginApi) {
  api.registerTool(((ctx: OpenClawPluginToolContext) =>
    createBrowserTool({
      sandboxBridgeUrl: ctx.browser?.sandboxBridgeUrl,
      allowHostControl: ctx.browser?.allowHostControl,
      agentSessionKey: ctx.sessionKey,
    })) as OpenClawPluginToolFactory);
  api.registerCli(({ program }) => registerBrowserCli(program), { commands: ["browser"] });
  api.registerGatewayMethod("browser.request", handleBrowserGatewayRequest, {
    scope: "operator.write",
  });
  api.registerService(createBrowserPluginService());
}
