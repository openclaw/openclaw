import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import type { SlackChannelConfigResolved } from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackMessageSourceOptions } from "./types.js";

export function resolveSlackAllowBotsMode(
  channelConfig: SlackChannelConfigResolved | null,
  account: ResolvedSlackAccount,
  cfg: SlackMonitorContext["cfg"],
): "off" | "all" | "mentions" {
  const setting =
    channelConfig?.allowBots ?? account.config?.allowBots ?? cfg.channels?.slack?.allowBots ?? true;
  return setting === "mentions" ? "mentions" : setting ? "all" : "off";
}

/**
 * Slack stamps the posting app's bot_id on chat.postMessage calls made with a user token, even
 * though the message is authored by that user. Posts from configured apps whose `user` is a
 * human are classified by `user`, so human sender gates apply and bot gates and loop accounting
 * do not. The same app's bot-token posts name its bot user and stay bot messages; a failed user
 * lookup also keeps the bot classification. This app is never trusted.
 */
export async function resolveSlackUserTokenAuthor(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  opts: Pick<SlackMessageSourceOptions, "eventScope">;
}): Promise<SlackMessageEvent> {
  const { ctx, message } = params;
  if (
    !message.bot_id ||
    !message.user ||
    !message.app_id ||
    message.subtype === "bot_message" ||
    !params.account.config.trustedUserTokenAppIds?.includes(message.app_id) ||
    message.app_id === ctx.apiAppId ||
    message.bot_id === ctx.botId ||
    message.user === ctx.botUserId ||
    (await ctx.resolveUserName(message.user, params.opts.eventScope)).isBot !== false
  ) {
    return message;
  }
  const { bot_id: _botId, bot_profile: _botProfile, ...userMessage } = message;
  return userMessage;
}
