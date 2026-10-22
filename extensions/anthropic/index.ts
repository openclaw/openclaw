import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerAnthropicPlugin } from "./register.runtime.js";

export default definePluginEntry({
  id: "anthropic",
  name: "Anthropic",
  description: "Anthropic models, Claude CLI, and native Claude session catalog",
  register: registerAnthropicPlugin,
});
