import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emailPlugin } from "./src/channel";
import { setEmailRuntime } from "./src/channel";

const plugin = {
  id: "email",
  register(api: OpenClawPluginApi) {
    setEmailRuntime(api.runtime);
    api.registerChannel({ plugin: emailPlugin });
  },
};

export default plugin;
