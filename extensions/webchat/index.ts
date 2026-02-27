import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { webchatOutbound } from "../../src/channels/plugins/outbound/webchat.js";

const webchatPlugin: ChannelPlugin = {
  id: "webchat",
  meta: {
    id: "webchat",
    label: "WebChat",
    selectionLabel: "WebChat",
    docsPath: "",
    blurb: "Browser-based chat delivered via the gateway",
    order: 999,
  },
  capabilities: {
    chatTypes: ["direct"],
  },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: () => ({ accountId: "default", enabled: true }),
  },
  outbound: webchatOutbound,
};

const plugin = {
  id: "webchat",
  name: "WebChat",
  description: "OpenClaw WebChat channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerChannel({ plugin: webchatPlugin });
  },
};

export default plugin;
