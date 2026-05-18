import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { getAccessToken } from "../../engine/messaging/sender.js";
import { ChannelApiSchema, executeChannelApi } from "../../engine/tools/channel-api.js";
import type { ChannelApiParams } from "../../engine/tools/channel-api.js";
import { listQQBotAccountIds, resolveQQBotAccount } from "../config.js";

type ChannelToolAccount = {
  appId: string;
  clientSecret: string;
};

type ChannelToolDeps = {
  getAccessToken: typeof getAccessToken;
  executeChannelApi: typeof executeChannelApi;
};

const defaultDeps: ChannelToolDeps = {
  getAccessToken,
  executeChannelApi,
};

/**
 * Create the QQ channel API proxy tool.
 *
 * The tool acts as an authenticated HTTP proxy for the QQ Open Platform
 * channel APIs. Agents learn endpoint details from the skill docs and
 * send requests through this proxy.
 */
export function createChannelTool(
  account: ChannelToolAccount,
  toolContext: OpenClawPluginToolContext = {},
  deps: ChannelToolDeps = defaultDeps,
): AnyAgentTool {
  return {
    name: "qqbot_channel_api",
    label: "QQBot Channel API",
    ownerOnly: true,
    description:
      "Authenticated HTTP proxy for QQ Open Platform channel APIs. " +
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
      if (toolContext.senderIsOwner !== true) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "QQBot channel API requires an owner-authorized sender.",
              }),
            },
          ],
          details: { error: "QQBot channel API requires an owner-authorized sender." },
        };
      }
      const accessToken = await deps.getAccessToken(account.appId, account.clientSecret);
      return deps.executeChannelApi(params as ChannelApiParams, { accessToken });
    },
  };
}

/** Register the QQ channel API proxy tool. */
export function registerChannelTool(api: OpenClawPluginApi): void {
  const cfg = api.config;
  if (!cfg) {
    return;
  }

  const accountIds = listQQBotAccountIds(cfg);
  if (accountIds.length === 0) {
    return;
  }

  const firstAccountId = accountIds[0];
  const account = resolveQQBotAccount(cfg, firstAccountId);

  if (!account.appId || !account.clientSecret) {
    return;
  }

  api.registerTool((ctx) => createChannelTool(account, ctx), { name: "qqbot_channel_api" });
}
