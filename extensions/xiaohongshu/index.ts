import type { OpenClawPluginApi } from "openclaw/plugin-sdk/xiaohongshu";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/xiaohongshu";
import { registerXhsTools } from "./src/tools.js";

const plugin = {
  id: "xiaohongshu",
  name: "Xiaohongshu",
  description: "Xiaohongshu (RED) note search, reading, and interaction tools.",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    registerXhsTools(api);
  },
};

export default plugin;
