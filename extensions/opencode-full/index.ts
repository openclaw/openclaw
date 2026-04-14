import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerOpencodeFullPlugin } from "./plugin-registration.js";

export default definePluginEntry({
  id: "opencode-full",
  name: "OpenCode Full Integration",
  description: "OpenCode tools, commands, and session bridging for OpenClaw",
  register: registerOpencodeFullPlugin,
});
