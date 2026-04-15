import type {
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/plugin-entry";

export const browserPluginReload = { restartPrefixes: ["browser"] };

export const browserPluginNodeHostCommands: OpenClawPluginNodeHostCommand[] = [
  {
    command: "browser.proxy",
    cap: "browser",
    handle: async (paramsJSON) => {
      const { runBrowserProxyCommand } = await import("./register.runtime.js");
      return runBrowserProxyCommand(paramsJSON);
    },
  },
];

export const browserSecurityAuditCollectors: import("openclaw/plugin-sdk/plugin-entry").OpenClawPluginSecurityAuditCollector[] =
  [
    async (ctx) => {
      const { collectBrowserSecurityAuditFindings } = await import("./register.runtime.js");
      return collectBrowserSecurityAuditFindings(ctx);
    },
  ];

export async function registerBrowserPlugin(api: OpenClawPluginApi) {
  api.registerTool((async (ctx: OpenClawPluginToolContext) => {
    const { createBrowserTool } = await import("./register.runtime.js");
    return createBrowserTool({
      sandboxBridgeUrl: ctx.browser?.sandboxBridgeUrl,
      allowHostControl: ctx.browser?.allowHostControl,
      agentSessionKey: ctx.sessionKey,
    });
  }) as OpenClawPluginToolFactory);
  api.registerCli(
    async ({ program }) => {
      const { registerBrowserCli } = await import("./register.runtime.js");
      registerBrowserCli(program);
    },
    {
      commands: ["browser"],
      descriptors: [
        {
          name: "browser",
          description: "Manage OpenClaw's dedicated browser (Chrome/Chromium)",
          hasSubcommands: true,
        },
      ],
    },
  );
  api.registerGatewayMethod("browser.request", async (opts) => {
    const { handleBrowserGatewayRequest } = await import("./register.runtime.js");
    return handleBrowserGatewayRequest(opts);
  }, {
    scope: "operator.write",
  });
  let loadedService:
    | Awaited<ReturnType<(typeof import("./register.runtime.js"))["createBrowserPluginService"]>>
    | null = null;
  api.registerService({
    id: "browser-control",
    start: async (ctx) => {
      if (!loadedService) {
        const { createBrowserPluginService } = await import("./register.runtime.js");
        loadedService = createBrowserPluginService();
      }
      await loadedService.start(ctx);
    },
    stop: async (ctx) => {
      if (!loadedService?.stop) {
        return;
      }
      await loadedService.stop(ctx);
    },
  });
}
