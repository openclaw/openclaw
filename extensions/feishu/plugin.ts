import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { emptyPluginConfigSchema } from "../../src/plugins/config-schema.js";
import { createLazyChannelPlugin, loadLazyModuleExport } from "../../src/plugins/lazy-channel.js";
import type { OpenClawPluginToolContext } from "../../src/plugins/types.js";
import { setFeishuRuntime } from "./src/runtime.js";

type ToolRegistrar = (api: OpenClawPluginApi) => void;

function createLazyToolFactory(params: {
  api: OpenClawPluginApi;
  importerUrl: string;
  modulePath: string;
  exportName: string;
}) {
  return (ctx: OpenClawPluginToolContext): AnyAgentTool[] => {
    const registerTools = loadLazyModuleExport<ToolRegistrar>({
      importerUrl: params.importerUrl,
      modulePath: params.modulePath,
      exportName: params.exportName,
    });
    const tools: AnyAgentTool[] = [];
    registerTools({
      ...params.api,
      registerTool(tool) {
        const resolved = typeof tool === "function" ? tool(ctx) : tool;
        if (!resolved) {
          return;
        }
        tools.push(...(Array.isArray(resolved) ? resolved : [resolved]));
      },
    });
    return tools;
  };
}

const feishuPlugin = createLazyChannelPlugin({
  importerUrl: import.meta.url,
  modulePath: "./src/channel.js",
  exportName: "feishuPlugin",
  pluginId: "feishu",
});

const plugin = {
  id: "feishu",
  name: "Feishu",
  description: "Feishu/Lark channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setFeishuRuntime(api.runtime);
    api.registerChannel({ plugin: feishuPlugin });
    api.registerTool(
      createLazyToolFactory({
        api,
        importerUrl: import.meta.url,
        modulePath: "./src/docx.js",
        exportName: "registerFeishuDocTools",
      }),
      { names: ["feishu_doc", "feishu_app_scopes"] },
    );
    api.registerTool(
      createLazyToolFactory({
        api,
        importerUrl: import.meta.url,
        modulePath: "./src/chat.js",
        exportName: "registerFeishuChatTools",
      }),
      { name: "feishu_chat" },
    );
    api.registerTool(
      createLazyToolFactory({
        api,
        importerUrl: import.meta.url,
        modulePath: "./src/wiki.js",
        exportName: "registerFeishuWikiTools",
      }),
      { name: "feishu_wiki" },
    );
    api.registerTool(
      createLazyToolFactory({
        api,
        importerUrl: import.meta.url,
        modulePath: "./src/drive.js",
        exportName: "registerFeishuDriveTools",
      }),
      { name: "feishu_drive" },
    );
    api.registerTool(
      createLazyToolFactory({
        api,
        importerUrl: import.meta.url,
        modulePath: "./src/perm.js",
        exportName: "registerFeishuPermTools",
      }),
      { name: "feishu_perm" },
    );
    api.registerTool(
      createLazyToolFactory({
        api,
        importerUrl: import.meta.url,
        modulePath: "./src/bitable.js",
        exportName: "registerFeishuBitableTools",
      }),
      {
        names: [
          "feishu_bitable_get_meta",
          "feishu_bitable_list_fields",
          "feishu_bitable_list_records",
          "feishu_bitable_get_record",
          "feishu_bitable_create_record",
          "feishu_bitable_update_record",
          "feishu_bitable_create_app",
          "feishu_bitable_create_field",
        ],
      },
    );
  },
};

export default plugin;
