import type { OpenClawPluginApi } from "openclaw/plugin-sdk/line";
import type { ReplyPayload } from "../../src/auto-reply/types.js";
import { emptyPluginConfigSchema } from "../../src/plugins/config-schema.js";
import { createLazyChannelPlugin, loadLazyModuleExport } from "../../src/plugins/lazy-channel.js";
import { setLineRuntime } from "./src/runtime.js";

const linePlugin = createLazyChannelPlugin({
  importerUrl: import.meta.url,
  modulePath: "./src/channel.js",
  exportName: "linePlugin",
  pluginId: "line",
});

const plugin = {
  id: "line",
  name: "LINE",
  description: "LINE Messaging API channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setLineRuntime(api.runtime);
    api.registerChannel({ plugin: linePlugin });
    api.registerCommand({
      name: "card",
      description: "Send a rich card message (LINE).",
      acceptsArgs: true,
      requireAuth: false,
      handler: async (ctx) =>
        await loadLazyModuleExport<(commandCtx: typeof ctx) => Promise<ReplyPayload>>({
          importerUrl: import.meta.url,
          modulePath: "./src/card-command.js",
          exportName: "handleLineCardCommand",
        })(ctx),
    });
  },
};

export default plugin;
