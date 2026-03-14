import type { OpenClawPluginApi } from "openclaw/plugin-sdk/nostr";
import { emptyPluginConfigSchema } from "../../src/plugins/config-schema.js";
import { createLazyChannelPlugin, loadLazyModuleExport } from "../../src/plugins/lazy-channel.js";
import { setNostrRuntime } from "./src/runtime.js";

const nostrPlugin = createLazyChannelPlugin({
  importerUrl: import.meta.url,
  modulePath: "./src/channel.js",
  exportName: "nostrPlugin",
  pluginId: "nostr",
});

const plugin = {
  id: "nostr",
  name: "Nostr",
  description: "Nostr DM channel plugin via NIP-04",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setNostrRuntime(api.runtime);
    api.registerChannel({ plugin: nostrPlugin });
    api.registerHttpRoute({
      path: "/api/channels/nostr",
      auth: "gateway",
      match: "prefix",
      handler: async (req, res) =>
        await loadLazyModuleExport<
          (
            request: typeof req,
            response: typeof res,
            pluginApi: OpenClawPluginApi,
          ) => Promise<boolean | void>
        >({
          importerUrl: import.meta.url,
          modulePath: "./src/nostr-profile-http-route.js",
          exportName: "handleNostrProfileHttpRoute",
        })(req, res, api),
    });
  },
};

export default plugin;
