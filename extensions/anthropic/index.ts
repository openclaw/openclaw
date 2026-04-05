import { definePluginEntry } from "mullusi/plugin-sdk/plugin-entry";
import { registerAnthropicPlugin } from "./register.runtime.js";

export default definePluginEntry({
  id: "anthropic",
  name: "Anthropic Provider",
  description: "Bundled Anthropic provider plugin",
  register(api) {
    return registerAnthropicPlugin(api);
  },
});
