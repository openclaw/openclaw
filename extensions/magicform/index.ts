import type { OpenClawPluginApi } from "openclaw/plugin-sdk/magicform";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/magicform";
import { createMagicFormPlugin } from "./src/channel.js";
import { setMagicFormRuntime } from "./src/runtime.js";

const plugin = {
  id: "magicform",
  name: "MagicForm",
  description: "Native MagicForm channel plugin for OpenClaw",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setMagicFormRuntime(api.runtime);
    api.registerChannel({ plugin: createMagicFormPlugin() });
  },
};

export default plugin;
