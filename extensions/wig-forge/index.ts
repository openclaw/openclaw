import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { wigForgeConfigSchema, resolveWigForgeConfig } from "./src/config.js";
import { createWigForgeHttpHandler } from "./src/http.js";
import { WIG_FORGE_PROMPT_GUIDANCE } from "./src/prompt-guidance.js";
import { createWigForgeTools } from "./src/tool.js";

const wigForgePlugin = {
  id: "wig-forge",
  name: "Wig Forge",
  description: "Capture-backed wearable asset minting for OpenClaw bot reward loops.",
  configSchema: wigForgeConfigSchema,
  register(api: OpenClawPluginApi) {
    const resolvedConfig = resolveWigForgeConfig(api.pluginConfig);
    api.registerTool((ctx) => createWigForgeTools({ api, ctx, config: resolvedConfig }), {
      names: [
        "wig_forge_mint",
        "wig_inventory_list",
        "wig_inventory_equip",
        "wig_wish_create",
        "wig_wish_list",
        "wig_wish_grant",
      ],
    });
    api.registerHttpRoute({
      path: "/plugins/wig-forge",
      auth: "plugin",
      match: "prefix",
      handler: createWigForgeHttpHandler({
        config: resolvedConfig,
        logger: api.logger,
      }),
    });
    api.on("before_prompt_build", async () => ({
      prependSystemContext: WIG_FORGE_PROMPT_GUIDANCE,
    }));
  },
};

export default wigForgePlugin;
