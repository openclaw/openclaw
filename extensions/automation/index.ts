import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { registerAutomationPlugin } from "./src/register.js";

export default definePluginEntry({
  id: "automation",
  name: "Automation Gateway",
  description: "Telegram/WeChat → Claude CLI + Codex CLI intelligent routing and workflow automation",
  register(api: OpenClawPluginApi) {
    return registerAutomationPlugin(api);
  },
});
