import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/zalouser";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/zalouser";
import { zalouserPlugin } from "./src/channel.js";
import { setZalouserRuntime } from "./src/runtime.js";
import { ZalouserToolSchema, executeZalouserTool } from "./src/tool.js";

const plugin = {
  id: "zalouser",
  name: "Zalo Personal",
  description: "Zalo personal account messaging via native zca-js integration",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setZalouserRuntime(api.runtime);
    api.registerChannel(zalouserPlugin);
    if (api.registrationMode !== "full") {
      return;
    }

    api.registerTool({
      name: "zalouser",
      label: "Zalo Personal",
      description:
        "Send messages and access data via Zalo personal account. " +
        "Actions: send (text message), image (send image URL), link (send link), " +
        "friends (list/search friends), groups (list groups), me (profile info), status (auth check).",
      parameters: ZalouserToolSchema,
      execute: executeZalouserTool,
    } as AnyAgentTool);
  },
};

export default plugin;
