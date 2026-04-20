import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
const CHANNEL_ID = "wecom" as const;

export default defineBundledChannelEntry({
  id: "wecom",
  name: "WeCom",
  description: "WeCom channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "wecomPlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setWeComRuntime",
  },
  configSchema: () => {
    return loadBundledEntryExportSync<
      typeof import("./config-schema-api.js").wecomChannelConfigSchema
    >(import.meta.url, {
      specifier: "./config-schema-api.js",
      exportName: "wecomChannelConfigSchema",
    });
  },
  registerFull(api: OpenClawPluginApi) {
    // Register wecom_mcp tool: invoke WeCom MCP Server via HTTP
    const createWeComMcpTool = loadBundledEntryExportSync<
      typeof import("./mcp-api.js").createWeComMcpTool
    >(import.meta.url, {
      specifier: "./mcp-api.js",
      exportName: "createWeComMcpTool",
    });
    api.registerTool(createWeComMcpTool() as unknown as Parameters<typeof api.registerTool>[0], {
      name: "wecom_mcp",
    });

    // Inject media-send instructions (WeCom channel only)
    api.on("before_prompt_build", (_event, ctx) => {
      if (ctx?.channelId !== CHANNEL_ID) {
        return undefined;
      }
      return {
        appendSystemContext:
          "重要：涉及发送图片/视频/语音/文件给用户时，请务必使用 `MEDIA:` 指令。详见 wecom-send-media 这个 skill（技能）。",
      };
    });
  },
});
