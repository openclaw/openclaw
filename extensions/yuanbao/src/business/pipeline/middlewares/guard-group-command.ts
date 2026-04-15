/**
 * Middleware: group command whitelist guard
 *
 * 仅对已注册的 openclaw 命令生效，非公开命令仅 bot owner 可执行。
 * 未注册的 /xxx 消息（如 /asdasdasd）不受此限制，当作普通文本传给 AI。
 */

import { getMember } from "../../../infra/cache/member.js";
import { sendGroupMsgBody } from "../../../infra/transport.js";
import type { YuanbaoMsgBodyElement } from "../../../types.js";
import { prepareOutboundContent, buildOutboundMsgBody } from "../../messaging/handlers/index.js";
import type { MiddlewareDescriptor } from "../types.js";

/** 群聊中所有人都能用的命令白名单 */
const GROUP_PUBLIC_COMMANDS = new Set<string>([]);

export const guardGroupCommand: MiddlewareDescriptor = {
  name: "guard-group-command",
  when: (ctx) => ctx.isGroup,
  handler: async (ctx, next) => {
    const { core, config, rawBody, raw, account, groupCode, fromAccount } = ctx;
    const hasRegisteredCommand = core.channel.text.hasControlCommand(rawBody, config);

    if (hasRegisteredCommand) {
      const cmdMatch = rawBody.trim().match(/^\/([a-z_-]+)/i);
      if (cmdMatch) {
        const cmdName = cmdMatch[1].toLowerCase();
        const isOwner = Boolean(raw.bot_owner_id && raw.from_account === raw.bot_owner_id);

        if (!GROUP_PUBLIC_COMMANDS.has(cmdName) && !isOwner) {
          ctx.log.info(
            `[guard-group-command] group command /${cmdName} owner-only, discarding <- group:${groupCode}, from: ${fromAccount}`,
          );
          await sendGroupMsgBody({
            account,
            groupCode: groupCode!,
            msgBody: buildOutboundMsgBody(
              prepareOutboundContent(
                `⚠️ /${cmdName} 仅限创建者${!raw?.bot_owner_id ? "并且在私聊模式下" : ""}使用哦~`,
                groupCode,
                getMember(account.accountId),
              ),
            ) as YuanbaoMsgBodyElement[],
            fromAccount: account.botId,
            refMsgId: raw.msg_id || raw.msg_key || undefined,
            refFromAccount: fromAccount,
            wsClient: ctx.wsClient,
          });
          return; // 终止管线
        }
      }
    }

    await next();
  },
};
