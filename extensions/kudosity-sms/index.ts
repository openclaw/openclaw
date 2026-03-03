/**
 * Kudosity SMS channel plugin for OpenClaw.
 *
 * This is the plugin entry point — it registers the Kudosity SMS channel
 * with OpenClaw's plugin system.
 *
 * @see https://developers.kudosity.com
 */

import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { kudositySmsPlugin } from "./src/channel.js";
import { setKudositySmsRuntime } from "./src/runtime.js";

const plugin = {
  id: "kudosity-sms",
  name: "Kudosity SMS",
  description: "Cloud SMS channel powered by Kudosity — send and receive SMS via the Kudosity API",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    // Store the runtime reference for use by other modules
    setKudositySmsRuntime(api.runtime);

    // Register the channel plugin (onboarding is on the plugin object itself)
    api.registerChannel({
      plugin: kudositySmsPlugin as ChannelPlugin,
    });
  },
};

export default plugin;
