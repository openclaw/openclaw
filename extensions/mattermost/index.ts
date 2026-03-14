import type { OpenClawPluginApi } from "openclaw/plugin-sdk/mattermost";
import { emptyPluginConfigSchema } from "../../src/plugins/config-schema.js";
import { createLazyChannelPlugin, loadLazyModuleExport } from "../../src/plugins/lazy-channel.js";
import { resolveSlashCallbackPaths } from "./src/mattermost/slash-callback-paths.js";
import { setMattermostRuntime } from "./src/runtime.js";

const mattermostPlugin = createLazyChannelPlugin({
  importerUrl: import.meta.url,
  modulePath: "./src/channel.js",
  exportName: "mattermostPlugin",
  pluginId: "mattermost",
});

const plugin = {
  id: "mattermost",
  name: "Mattermost",
  description: "Mattermost channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setMattermostRuntime(api.runtime);
    api.registerChannel({ plugin: mattermostPlugin });
    const mmConfig = api.config.channels?.mattermost as Record<string, unknown> | undefined;
    for (const callbackPath of resolveSlashCallbackPaths(mmConfig)) {
      api.registerHttpRoute({
        path: callbackPath,
        auth: "plugin",
        handler: async (req, res) =>
          await loadLazyModuleExport<
            (
              request: typeof req,
              response: typeof res,
              pluginApi: OpenClawPluginApi,
            ) => Promise<void>
          >({
            importerUrl: import.meta.url,
            modulePath: "./src/mattermost/slash-state.js",
            exportName: "handleSlashCommandRoute",
          })(req, res, api),
      });
      api.logger.info?.(`mattermost: registered slash command callback at ${callbackPath}`);
    }
  },
};

export default plugin;
