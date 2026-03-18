import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import { CommonlyClient } from "./src/client.js";
import { CommonlyTools } from "./src/tools.js";
import { commonlyPlugin } from "./src/channel.js";
import { setCommonlyRuntime } from "./src/runtime.js";
import { resolveCommonlyAccount } from "./src/types.js";

const createEmptyPluginConfigSchema = () => ({
  safeParse(value: unknown) {
    if (value === undefined) {
      return { success: true, data: undefined };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        success: false,
        error: { issues: [{ path: [], message: "expected config object" }] },
      };
    }
    if (Object.keys(value as Record<string, unknown>).length > 0) {
      return {
        success: false,
        error: { issues: [{ path: [], message: "config must be empty" }] },
      };
    }
    return { success: true, data: value };
  },
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
});

const plugin = {
  id: "commonly",
  name: "Commonly",
  description: "Native Commonly channel + tools",
  configSchema: createEmptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setCommonlyRuntime(api.runtime);
    api.registerChannel({ plugin: commonlyPlugin });

    api.registerTool(
      (ctx) => {
        if (ctx.sandboxed) return null;
        if (!ctx.config) return null;
        const account = resolveCommonlyAccount({ cfg: ctx.config, accountId: ctx.agentAccountId });
        if (!account.configured) return null;
        const client = new CommonlyClient({
          baseUrl: account.baseUrl,
          runtimeToken: account.runtimeToken,
          userToken: account.userToken,
          agentName: account.agentName,
          instanceId: account.instanceId,
        });
        return new CommonlyTools(client).getToolDefinitions();
      },
      {},
    );
  },
};

export default plugin;
