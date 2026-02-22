/**
 * OpenClaw Zulip Channel Plugin
 * 
 * Provides Zulip chat integration for OpenClaw.
 */

import type { OpenClawPluginApi, ChannelPlugin } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { zulipPlugin } from "./src/channel.js";
import { setZulipRuntime } from "./src/runtime.js";

interface OpenClawPlugin {
  id: string;
  name: string;
  description: string;
  configSchema: ReturnType<typeof emptyPluginConfigSchema>;
  register: (api: OpenClawPluginApi) => void;
}

const plugin: OpenClawPlugin = {
  id: "zulip",
  name: "Zulip",
  description: "Zulip channel plugin for OpenClaw",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setZulipRuntime(api.runtime);
    api.registerChannel(zulipPlugin as ChannelPlugin);
  },
};

export default plugin;

// Re-export types for external use
export type { ZulipConfig, ZulipAccountConfig } from "./src/config-schema.js";
export type { ResolvedZulipAccount } from "./src/zulip/accounts.js";
export type { ZulipClient, ZulipMessage, ZulipUser, ZulipStream } from "./src/zulip/client.js";
