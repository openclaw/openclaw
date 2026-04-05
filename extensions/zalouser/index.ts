import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { zalouserPlugin } from "./src/channel.js";
import { setZalouserRuntime } from "./src/runtime.js";
import { createZalouserTool } from "./src/tool.js";

export { zalouserPlugin } from "./src/channel.js";
export { setZalouserRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "zalouser",
  name: "Zalo Personal",
  description: "Zalo personal account messaging via native zca-js integration",
  plugin: zalouserPlugin,
  setRuntime: setZalouserRuntime,
  registerFull(api) {
    api.registerTool((ctx) => createZalouserTool(ctx), { name: "zalouser" });
  },
});
