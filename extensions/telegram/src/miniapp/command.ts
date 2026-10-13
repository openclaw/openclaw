import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi, PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import type { TelegramMiniAppLaunchTickets } from "./launch-ticket.js";
import { isTelegramMiniAppOwner } from "./owner.js";
import { resolveTelegramMiniAppUrls, TELEGRAM_MINIAPP_URL_ERROR } from "./url.js";

export function registerTelegramMiniAppCommand(
  api: OpenClawPluginApi,
  launchTickets: TelegramMiniAppLaunchTickets,
): void {
  api.registerCommand({
    name: "controlui",
    description: "Open the OpenClaw Control UI",
    channels: ["telegram"],
    requireAuth: true,
    exposeSenderIsOwner: true,
    handler: async (ctx) => {
      if (!isTelegramDirectCommand(ctx)) {
        return { text: "open this in a DM with the bot" };
      }
      const cfg = (api.runtime.config?.current?.() ?? api.config) as OpenClawConfig;
      const accountId = normalizeAccountId(ctx.accountId ?? DEFAULT_ACCOUNT_ID);
      const senderId = ctx.senderId?.trim() ?? "";
      const userId = /^\d+$/.test(senderId)
        ? senderId
        : (/^telegram:(\d+)$/.exec(ctx.from?.trim() ?? "")?.[1] ?? "");
      if (!(await isTelegramMiniAppOwner({ cfg, accountId, userId }))) {
        return {
          text:
            "Restricted to the bot owner. Ask your OpenClaw administrator to add your numeric " +
            `Telegram user ID${userId ? ` (${userId})` : ""} to this bot account's allowFrom or ` +
            "commands.ownerAllowFrom, then retry /controlui. Wildcards and usernames do not grant Control UI access.",
        };
      }
      let pageUrl: URL;
      try {
        pageUrl = new URL((await resolveTelegramMiniAppUrls({ cfg })).pageUrl);
      } catch {
        return { text: TELEGRAM_MINIAPP_URL_ERROR };
      }
      pageUrl.searchParams.set("accountId", accountId);
      pageUrl.hash = new URLSearchParams({
        launchTicket: launchTickets.issue({ accountId, userId }),
      }).toString();
      return {
        text: "Open OpenClaw Control UI.",
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Open Control UI", webApp: { url: pageUrl.toString() } }],
            },
          ],
        },
      };
    },
  });
}

function isTelegramDirectCommand(ctx: PluginCommandContext): boolean {
  // DM-only because Telegram permits web_app inline buttons only in private chats.
  const from = ctx.from?.trim() ?? "";
  const sessionKey = ctx.sessionKey?.trim() ?? "";
  if (from.startsWith("telegram:group:") || sessionKey.includes(":telegram:group:")) {
    return false;
  }
  return /^telegram:\d+$/.test(from) || sessionKey.includes(":telegram:direct:");
}
