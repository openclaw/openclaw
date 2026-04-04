import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "anthropic",
  name: "Anthropic Provider",
  description: "Bundled Anthropic provider plugin",
  async register(api) {
    const { registerAnthropicPlugin } = await import("./register.runtime.js");
    await registerAnthropicPlugin(api);
  },
});
