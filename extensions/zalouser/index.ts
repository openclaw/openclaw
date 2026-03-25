import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import type { AnyAgentTool } from "./runtime-api.js";
import { zalouserPlugin } from "./src/channel.js";
import { setZalouserRuntime } from "./src/runtime.js";
import { ZalouserToolSchema, executeZalouserTool } from "./src/tool.js";

export { zalouserPlugin } from "./src/channel.js";
export { setZalouserRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "zalouser",
  name: "Zalo Personal",
  description: "Zalo personal account messaging via native zca-js integration",
  plugin: zalouserPlugin,
  setRuntime: setZalouserRuntime,
  registerFull(api) {
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
});
