import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/zalouser";
import { emptyPluginConfigSchema } from "../../src/plugins/config-schema.js";
import {
  createLazyChannelDock,
  createLazyChannelPlugin,
  loadLazyModuleExport,
} from "../../src/plugins/lazy-channel.js";
import { setZalouserRuntime } from "./src/runtime.js";
import { ZalouserToolSchema } from "./src/tool-schema.js";

const zalouserPlugin = createLazyChannelPlugin({
  importerUrl: import.meta.url,
  modulePath: "./src/channel.js",
  exportName: "zalouserPlugin",
  pluginId: "zalouser",
});
const zalouserDock = createLazyChannelDock({
  importerUrl: import.meta.url,
  modulePath: "./src/channel.js",
  exportName: "zalouserDock",
});

const plugin = {
  id: "zalouser",
  name: "Zalo Personal",
  description: "Zalo personal account messaging via native zca-js integration",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setZalouserRuntime(api.runtime);
    api.registerChannel({ plugin: zalouserPlugin, dock: zalouserDock });
    api.registerTool({
      name: "zalouser",
      label: "Zalo Personal",
      description:
        "Send messages and access data via Zalo personal account. " +
        "Actions: send (text message), image (send image URL), link (send link), " +
        "friends (list/search friends), groups (list groups), me (profile info), status (auth check).",
      parameters: ZalouserToolSchema,
      execute: async (id, params) =>
        await loadLazyModuleExport<
          (toolId: string, toolParams: Record<string, unknown>) => Promise<unknown>
        >({
          importerUrl: import.meta.url,
          modulePath: "./src/tool.js",
          exportName: "executeZalouserTool",
        })(id, params),
    } as AnyAgentTool);
  },
};

export default plugin;
