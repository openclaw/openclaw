import type { OpenClawPluginApi } from "openclaw/plugin-sdk/inboxapi";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/inboxapi";
import { createInboxApiPlugin } from "./src/channel.js";
import { setInboxApiRuntime } from "./src/runtime.js";

const plugin = {
  id: "inboxapi",
  name: "InboxAPI Email",
  description: "Email channel plugin for OpenClaw via InboxAPI",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setInboxApiRuntime(api.runtime);
    api.registerChannel({ plugin: createInboxApiPlugin() });
  },
};

export default plugin;
