import type { WebClient } from "@slack/web-api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveSlackAccount } from "./accounts.js";
import { createSlackWebClient, getSlackWriteClient } from "./client.js";
import { resolveSlackBotToken } from "./token.js";

/**
 * Slack workspace admin actions. These mutate channels and lookup users by
 * email, which require Slack scopes that are not included in the default
 * channel-plugin bot. The dispatcher (action-runtime.ts) gates them on
 * `channels.slack.actions.admin === true` and routes through these helpers.
 */

export type SlackAdminClientOpts = {
  cfg?: OpenClawConfig;
  accountId?: string;
  /** Explicit token override. When omitted, the resolved account token is used. */
  token?: string;
  client?: WebClient;
};

function resolveAdminToken(
  explicit: string | undefined,
  accountId: string | undefined,
  cfg: OpenClawConfig | undefined,
  scope: string,
): string {
  if (explicit?.trim()) {
    const token = resolveSlackBotToken(explicit);
    if (token) {
      return token;
    }
  }
  if (!cfg) {
    throw new Error(
      `Slack admin actions (${scope}) require a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.`,
    );
  }
  const resolvedCfg = requireRuntimeConfig(cfg, `Slack admin actions (${scope})`);
  const account = resolveSlackAccount({ cfg: resolvedCfg, accountId });
  // Prefer the bot token (when the bot has the required scopes) and fall back
  // to the user token only if the workspace has opted in via userTokenReadOnly=false.
  const allowUserWrites = account.config.userTokenReadOnly === false;
  const bot = resolveSlackBotToken(account.botToken ?? undefined);
  const user = account.userToken ? resolveSlackBotToken(account.userToken) : undefined;
  const token = bot ?? (allowUserWrites ? user : undefined);
  if (!token) {
    logVerbose(
      `slack admin actions: no usable token for ${scope} account=${account.accountId} ` +
        `bot=${Boolean(bot)} userWrites=${allowUserWrites} hasUser=${Boolean(user)}`,
    );
    throw new Error(
      `Slack admin action ${scope} requires a bot token (or an opt-in user token with userTokenReadOnly=false).`,
    );
  }
  return token;
}

async function getAdminClient(
  opts: SlackAdminClientOpts,
  mode: "read" | "write",
  scope: string,
): Promise<WebClient> {
  if (opts.client) {
    return opts.client;
  }
  const token = resolveAdminToken(opts.token, opts.accountId, opts.cfg, scope);
  return mode === "write" ? getSlackWriteClient(token) : createSlackWebClient(token);
}

export type SlackCreatedConversation = {
  id?: string;
  name?: string;
  is_private?: boolean;
  is_channel?: boolean;
  is_group?: boolean;
  created?: number;
  creator?: string;
};

export async function createSlackConversation(
  name: string,
  opts: SlackAdminClientOpts & { isPrivate?: boolean } = {},
): Promise<SlackCreatedConversation> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Slack conversations.create requires a non-empty channel name.");
  }
  const client = await getAdminClient(opts, "write", "conversations.create");
  const result = await client.conversations.create({
    name: trimmed,
    is_private: opts.isPrivate ?? false,
  });
  const channel = (result.channel ?? {}) as SlackCreatedConversation;
  return {
    id: channel.id,
    name: channel.name,
    is_private: channel.is_private,
    is_channel: channel.is_channel,
    is_group: channel.is_group,
    created: channel.created,
    creator: channel.creator,
  };
}

export type SlackUserLookup = {
  id?: string;
  name?: string;
  real_name?: string;
  team_id?: string;
  email?: string;
  deleted?: boolean;
  is_bot?: boolean;
};

export async function lookupSlackUserByEmail(
  email: string,
  opts: SlackAdminClientOpts = {},
): Promise<SlackUserLookup | null> {
  const trimmed = email.trim();
  if (!trimmed) {
    throw new Error("Slack users.lookupByEmail requires a non-empty email.");
  }
  const client = await getAdminClient(opts, "read", "users.lookupByEmail");
  try {
    const result = await client.users.lookupByEmail({ email: trimmed });
    const user = (result.user ?? null) as
      | (SlackUserLookup & { profile?: { email?: string } })
      | null;
    if (!user) {
      return null;
    }
    return {
      id: user.id,
      name: user.name,
      real_name: user.real_name,
      team_id: user.team_id,
      email: user.profile?.email ?? user.email,
      deleted: user.deleted,
      is_bot: user.is_bot,
    };
  } catch (err) {
    const code = (err as { data?: { error?: string } } | undefined)?.data?.error;
    if (code === "users_not_found") {
      return null;
    }
    throw err;
  }
}

export type SlackInviteResult = {
  channelId?: string;
  invited: string[];
  alreadyInChannel: string[];
};

export async function inviteSlackUsersToConversation(
  channelId: string,
  userIds: string[],
  opts: SlackAdminClientOpts = {},
): Promise<SlackInviteResult> {
  const channel = channelId.trim();
  if (!channel) {
    throw new Error("Slack conversations.invite requires a channelId.");
  }
  const users = userIds.map((id) => id.trim()).filter((id) => id.length > 0);
  if (users.length === 0) {
    throw new Error("Slack conversations.invite requires at least one userId.");
  }
  const client = await getAdminClient(opts, "write", "conversations.invite");
  const alreadyInChannel: string[] = [];
  const invited: string[] = [];
  // Slack's API rejects the entire call if any single user is already in the
  // channel. Invite one at a time so partial-success states are accurately
  // reported back to the agent without surprising rollbacks.
  for (const userId of users) {
    try {
      await client.conversations.invite({ channel, users: userId });
      invited.push(userId);
    } catch (err) {
      const code = (err as { data?: { error?: string } } | undefined)?.data?.error;
      if (code === "already_in_channel") {
        alreadyInChannel.push(userId);
        continue;
      }
      throw err;
    }
  }
  return { channelId: channel, invited, alreadyInChannel };
}

export type SlackChannelMembersPage = {
  channelId: string;
  members: string[];
  nextCursor?: string;
};

export async function listSlackChannelMembers(
  channelId: string,
  opts: SlackAdminClientOpts & { limit?: number; cursor?: string } = {},
): Promise<SlackChannelMembersPage> {
  const channel = channelId.trim();
  if (!channel) {
    throw new Error("Slack conversations.members requires a channelId.");
  }
  const client = await getAdminClient(opts, "read", "conversations.members");
  const result = await client.conversations.members({
    channel,
    ...(opts.limit ? { limit: opts.limit } : {}),
    ...(opts.cursor ? { cursor: opts.cursor } : {}),
  });
  const members = (result.members ?? []) as string[];
  const next = (result.response_metadata as { next_cursor?: string } | undefined)?.next_cursor;
  return {
    channelId: channel,
    members,
    ...(next ? { nextCursor: next } : {}),
  };
}
