import type { OpenClawPluginApi } from "openclaw/plugin-sdk/lanxin";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/lanxin";
import { lanxinPlugin } from "./src/channel.js";
import { setLanxinRuntime } from "./src/runtime.js";

const plugin = {
  id: "lanxin",
  name: "Lanxin",
  description: "Lanxin (蓝信) channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setLanxinRuntime(api.runtime);
    api.registerChannel({ plugin: lanxinPlugin });
  },
};

export default plugin;
