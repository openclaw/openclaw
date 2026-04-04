import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { qqbotPlugin } from "./src/channel.js";
import { resolveQQBotAccount } from "./src/config.js";
import { sendDocument, type MediaTargetContext } from "./src/outbound.js";
import { setQQBotRuntime } from "./src/runtime.js";
import { getFrameworkCommands } from "./src/slash-commands.js";
import { registerChannelTool } from "./src/tools/channel.js";
import { registerRemindTool } from "./src/tools/remind.js";

export { qqbotPlugin } from "./src/channel.js";
export { setQQBotRuntime, getQQBotRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "qqbot",
  name: "QQ Bot",
  description: "QQ Bot channel plugin",
  plugin: qqbotPlugin as ChannelPlugin,
  setRuntime: setQQBotRuntime,
  registerFull(api: OpenClawPluginApi) {
    registerChannelTool(api);
    registerRemindTool(api);

    // Register all requireAuth:true slash commands with the framework so that
    // resolveCommandAuthorization() applies commands.allowFrom.qqbot precedence
    // and qqbot: prefix normalization before any handler runs.
    for (const cmd of getFrameworkCommands()) {
      api.registerCommand({
        name: cmd.name,
        description: cmd.description,
        requireAuth: true,
        acceptsArgs: true,
        handler: async (ctx) => {
          // Derive the QQBot message type from ctx.from so that handlers that
          // inspect SlashCommandContext.type get the correct value.
          // ctx.from format: "qqbot:<type>:<id>" e.g. "qqbot:c2c:<senderId>"
          const fromStripped = (ctx.from ?? "").replace(/^qqbot:/i, "");
          const rawMsgType = fromStripped.split(":")[0] ?? "c2c";
          const msgType: "c2c" | "guild" | "dm" | "group" =
            rawMsgType === "group"
              ? "group"
              : rawMsgType === "channel"
                ? "guild"
                : rawMsgType === "dm"
                  ? "dm"
                  : "c2c";

          // Parse target for file sends (same from string).
          const colonIdx = fromStripped.indexOf(":");
          const targetId = colonIdx !== -1 ? fromStripped.slice(colonIdx + 1) : fromStripped;
          const targetType: "c2c" | "group" | "channel" | "dm" =
            rawMsgType === "group"
              ? "group"
              : rawMsgType === "channel"
                ? "channel"
                : rawMsgType === "dm"
                  ? "dm"
                  : "c2c";
          const account = resolveQQBotAccount(ctx.config, ctx.accountId ?? undefined);

          // Build a minimal SlashCommandContext from the framework PluginCommandContext.
          // commandAuthorized is always true here because the framework has already
          // verified the sender via resolveCommandAuthorization().
          const slashCtx = {
            type: msgType,
            senderId: ctx.senderId ?? "",
            messageId: "",
            eventTimestamp: new Date().toISOString(),
            receivedAt: Date.now(),
            rawContent: `/${cmd.name}${ctx.args ? ` ${ctx.args}` : ""}`,
            args: ctx.args ?? "",
            accountId: account.accountId,
            // appId is not available from PluginCommandContext directly; handlers
            // that need it should call resolveQQBotAccount(ctx.config, ctx.accountId).
            appId: account.appId,
            accountConfig: account.config,
            commandAuthorized: true,
            queueSnapshot: {
              totalPending: 0,
              activeUsers: 0,
              maxConcurrentUsers: 10,
              senderPending: 0,
            },
          };

          const result = await cmd.handler(slashCtx);

          // Plain-text result.
          if (typeof result === "string") {
            return { text: result };
          }

          // File result: send the file attachment via QQ API, return text summary.
          if (result && "filePath" in result) {
            try {
              const mediaCtx: MediaTargetContext = {
                targetType,
                targetId,
                account,
                logPrefix: `[qqbot:${account.accountId}]`,
              };
              await sendDocument(mediaCtx, result.filePath);
            } catch {
              // File send failed; the text summary is still returned below.
            }
            return { text: result.text };
          }

          return { text: "⚠️ 命令返回了意外结果。" };
        },
      });
    }
  },
});
