import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
const CHANNEL_ID = "wecom" as const;
const WEBHOOK_PATHS = {
  BOT: "/wecom",
  BOT_ALT: "/wecom/bot",
  AGENT: "/wecom/agent",
  BOT_PLUGIN: "/plugins/wecom/bot",
  AGENT_PLUGIN: "/plugins/wecom/agent",
} as const;

export default defineBundledChannelEntry({
  id: "wecom",
  name: "WeCom",
  description: "WeCom channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./src/channel.js",
    exportName: "wecomPlugin",
  },
  runtime: {
    specifier: "./src/runtime.js",
    exportName: "setWeComRuntime",
  },
  configSchema: () => {
    return loadBundledEntryExportSync<
      typeof import("./src/config-schema.js").wecomChannelConfigSchema
    >(import.meta.url, {
      specifier: "./src/config-schema.js",
      exportName: "wecomChannelConfigSchema",
    });
  },
  registerFull(api: OpenClawPluginApi) {
    // Register wecom_mcp tool: invoke WeCom MCP Server via HTTP
    const createWeComMcpTool = loadBundledEntryExportSync<
      typeof import("./src/mcp/index.js").createWeComMcpTool
    >(import.meta.url, {
      specifier: "./src/mcp/index.js",
      exportName: "createWeComMcpTool",
    });
    api.registerTool(createWeComMcpTool() as unknown as Parameters<typeof api.registerTool>[0], { name: "wecom_mcp" });

    const createWecomAgentWebhookHandler = loadBundledEntryExportSync<
      typeof import("./src/agent/webhook.js").createWecomAgentWebhookHandler
    >(import.meta.url, {
      specifier: "./src/agent/webhook.js",
      exportName: "createWecomAgentWebhookHandler",
    });
    const agentWebhookHandler = createWecomAgentWebhookHandler(api.runtime);

    // Register Agent-mode HTTP routes (prefix match covers accountId sub-paths)
    api.registerHttpRoute({
      path: WEBHOOK_PATHS.AGENT_PLUGIN,
      handler: agentWebhookHandler,
      auth: "plugin",
      match: "prefix",
    });
    api.registerHttpRoute({
      path: WEBHOOK_PATHS.AGENT,
      handler: agentWebhookHandler,
      auth: "plugin",
      match: "prefix",
    });

    // Register bot webhook HTTP routes (prefix match)
    const handleWecomWebhookRequest = loadBundledEntryExportSync<
      typeof import("./src/webhook/index.js").handleWecomWebhookRequest
    >(import.meta.url, {
      specifier: "./src/webhook/index.js",
      exportName: "handleWecomWebhookRequest",
    });
    const webhookRoutes = [WEBHOOK_PATHS.BOT_PLUGIN, WEBHOOK_PATHS.BOT_ALT, WEBHOOK_PATHS.BOT];
    for (const routePath of webhookRoutes) {
      api.registerHttpRoute({
        path: routePath,
        handler: handleWecomWebhookRequest,
        auth: "plugin",
        match: "prefix",
      });
    }

    // Inject media-send instructions (WeCom channel only)
    api.on("before_prompt_build", (_event, ctx) => {
      if (ctx?.channelId !== CHANNEL_ID) {
        return;
      }
      return {
        appendSystemContext: [
          "重要：涉及发送图片/视频/语音/文件给用户时，请务必使用 `MEDIA:` 指令。详见  wecom-send-media 这个 skill（技能）。",
          "重要：当需要向用户发送结构化卡片消息（如通知、投票、按钮选择等）时，请在回复中直接输出 JSON 代码块（```json ... ```），其中 card_type 字段标明卡片类型。详见 wecom-send-template-card 技能。",
        ].join("\n"),
      };
    });
  },
});
