import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { convosPlugin } from "./src/channel.js";
import { setConvosRuntime } from "./src/runtime.js";
import { setupConvosWithInvite } from "./src/setup.js";

const plugin = {
  id: "convos",
  name: "Convos",
  description: "E2E encrypted messaging via XMTP",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setConvosRuntime(api.runtime);
    api.registerChannel({ plugin: convosPlugin });

    // Register convos.setup gateway method for web UI
    api.registerGatewayMethod("convos.setup", async ({ params, respond }) => {
      try {
        const result = await setupConvosWithInvite({
          accountId:
            typeof (params as { accountId?: unknown }).accountId === "string"
              ? (params as { accountId?: string }).accountId
              : undefined,
          env:
            typeof (params as { env?: unknown }).env === "string"
              ? ((params as { env?: string }).env as "production" | "dev")
              : undefined,
          name:
            typeof (params as { name?: unknown }).name === "string"
              ? (params as { name?: string }).name
              : undefined,
        });
        respond(true, result, undefined);
      } catch (err) {
        respond(false, undefined, {
          code: -1,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  },
};

export default plugin;
