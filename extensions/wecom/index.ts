import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { emptyPluginConfigSchema } from "./src/openclaw-compat.js";
import { wecomPlugin } from "./src/channel.js";
import { createWeComMcpTool } from "./src/mcp/index.js";
import { setWeComRuntime } from "./src/runtime.js";
import { CHANNEL_ID, WEBHOOK_PATHS } from "./src/const.js";
import { createWecomAgentWebhookHandler } from "./src/agent/webhook.js";
import { handleWecomWebhookRequest } from "./src/webhook/index.js";

const plugin = {
  id: "wecom-openclaw-plugin",
  name: "企业微信",
  description: "企业微信 OpenClaw 插件",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {

    setWeComRuntime(api.runtime);
    api.registerChannel({ plugin: wecomPlugin });

    // 注册 wecom_mcp：通过 HTTP 直接调用企业微信 MCP Server
    api.registerTool(createWeComMcpTool() as any, { name: "wecom_mcp" });

    const agentWebhookHandler = createWecomAgentWebhookHandler(api.runtime);

    // 注册 Agent 模式 HTTP 路由（prefix match 覆盖带 accountId 的子路径）
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

        // ── 注册 bot Webhook HTTP 路由 ────────────────────────────────────────
    // 前缀匹配模式，同时覆盖 /plugins/wecom 和 /wecom 路径
    const webhookRoutes = [WEBHOOK_PATHS.BOT_PLUGIN, WEBHOOK_PATHS.BOT_ALT, WEBHOOK_PATHS.BOT];
    for (const routePath of webhookRoutes) {
      api.registerHttpRoute({
        path: routePath,
        handler: handleWecomWebhookRequest,
        auth: "plugin",
        match: "prefix",
      });
    }

    // 注入媒体发送指令和文件大小限制提示词（仅对企业微信 channel 生效）
    api.on("before_prompt_build", (_event, ctx) => {
      // 只在企业微信 channel 的会话中注入，避免影响其他 channel 插件
      if (ctx?.channelId !== CHANNEL_ID) {
        return;
      }
      return {
        appendSystemContext: [
          "重要：涉及发送图片/视频/语音/文件给用户时，请务必使用 `MEDIA:` 指令。详见  wecom-send-media 这个 skill（技能）。",
          "重要：当需要向用户发送结构化卡片消息（如通知、投票、按钮选择等）时，请在回复中直接输出 JSON 代码块（```json ... ```），其中 card_type 字段标明卡片类型。详见 wecom-send-template-card 技能。"
        ].join("\n"),
      };
    });
  },
};

export default plugin;
