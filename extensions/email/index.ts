import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { emailPlugin } from "./src/channel.js";
import { setEmailRuntime } from "./src/runtime.js";

const plugin = {
  id: "email",
  name: "Email",
  description: "SMTP outbound email channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setEmailRuntime(api.runtime);
    api.registerChannel({ plugin: emailPlugin });
  },
};

export default plugin;
