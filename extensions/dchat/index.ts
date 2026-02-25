import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { dchatPlugin } from "./src/channel.js";
import { setDchatRuntime } from "./src/runtime.js";

const plugin = {
  id: "dchat",
  name: "D-Chat / nMobile",
  description: "D-Chat/nMobile channel plugin (NKN relay network)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setDchatRuntime(api.runtime);
    api.registerChannel({ plugin: dchatPlugin });
  },
};

export default plugin;
