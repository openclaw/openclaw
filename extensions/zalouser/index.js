import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/zalouser";
import { zalouserDock, zalouserPlugin } from "./src/channel.js";
import { setZalouserRuntime } from "./src/runtime.js";
import { ZalouserToolSchema, executeZalouserTool } from "./src/tool.js";
const plugin = {
  id: "zalouser",
  name: "Zalo Personal",
  description: "Zalo personal account messaging via native zca-js integration",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    setZalouserRuntime(api.runtime);
    api.registerChannel({ plugin: zalouserPlugin, dock: zalouserDock });
    api.registerTool({
      name: "zalouser",
      label: "Zalo Personal",
      description: "Send messages and access data via Zalo personal account. Actions: send (text message), image (send image URL), link (send link), friends (list/search friends), groups (list groups), me (profile info), status (auth check).",
      parameters: ZalouserToolSchema,
      execute: executeZalouserTool
    });
  }
};
var zalouser_default = plugin;
export {
  zalouser_default as default
};
