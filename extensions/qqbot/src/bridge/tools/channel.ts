// Qqbot plugin module implements channel behavior.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { jsonResult as json } from "openclaw/plugin-sdk/tool-results";
import { ChannelApiSchema, executeChannelApi } from "../../engine/tools/channel-api.js";
import type { ChannelApiParams } from "../../engine/tools/channel-api.js";
import { listQQBotAccountIds, resolveQQBotAccount } from "../config.js";

function hasChannelApiCredentials(account: ReturnType<typeof resolveQQBotAccount>): boolean {
  return account.enabled && Boolean(account.appId && account.clientSecret);
}

/**
 * Register the QQ channel API proxy tool.
 *
 * The tool acts as an authenticated HTTP proxy for the QQ Open Platform
 * channel APIs. Agents learn endpoint details from the skill docs and
 * send requests through this proxy.
 */
export function registerChannelTool(api: Pick<OpenClawPluginApi, "config" | "registerTool">): void {
  const cfg = api.config;
  if (!cfg) {
    return;
  }

  const accountIds = listQQBotAccountIds(cfg);
  if (accountIds.length === 0) {
    return;
  }

  if (
    !accountIds.some((accountId) => hasChannelApiCredentials(resolveQQBotAccount(cfg, accountId)))
  ) {
    return;
  }

  api.registerTool(
    (ctx) => {
      const accountId =
        ctx.agentAccountId && accountIds.includes(ctx.agentAccountId)
          ? ctx.agentAccountId
          : accountIds.find((candidateAccountId) =>
              hasChannelApiCredentials(resolveQQBotAccount(cfg, candidateAccountId)),
            );
      return {
        name: "qqbot_channel_api",
        label: "QQBot Channel API",
        description:
          "Authenticated HTTP proxy for QQ Open Platform channel APIs. " +
          "Use write and delete endpoints only after explicit user intent; DELETE requires confirmed=true, and bulk deletes require bulkConfirmed=true after confirming the exact target. " +
          "Common endpoints: " +
          "list guilds GET /users/@me/guilds | " +
          "list channels GET /guilds/{guild_id}/channels | " +
          "get channel GET /channels/{channel_id} | " +
          "create channel POST /guilds/{guild_id}/channels | " +
          "list members GET /guilds/{guild_id}/members?after=0&limit=100 | " +
          "get member GET /guilds/{guild_id}/members/{user_id} | " +
          "list threads GET /channels/{channel_id}/threads | " +
          "create thread PUT /channels/{channel_id}/threads | " +
          "create announce POST /guilds/{guild_id}/announces | " +
          "create schedule POST /channels/{channel_id}/schedules. " +
          "See the qqbot-channel skill for full endpoint details.",
        parameters: ChannelApiSchema,
        async execute(_toolCallId, params) {
          const account = resolveQQBotAccount(cfg, accountId);
          if (!hasChannelApiCredentials(account)) {
            return json({
              error: `QQBot Channel API is not configured for account "${account.accountId}"`,
            });
          }
          const { getAccessToken } = await import("../../engine/messaging/sender.js");
          const accessToken = await getAccessToken(account.appId, account.clientSecret);
          return executeChannelApi(params as ChannelApiParams, { accessToken });
        },
      };
    },
    { name: "qqbot_channel_api" },
  );
}
