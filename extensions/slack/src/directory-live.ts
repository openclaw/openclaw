import type {
  ChannelDirectoryEntry,
  DirectoryConfigParams,
} from "openclaw/plugin-sdk/directory-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveSlackAccount } from "./accounts.js";
import { createSlackWebClient } from "./client.js";

type SlackUser = {
  id?: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
  is_app_user?: boolean;
  deleted?: boolean;
  profile?: {
    display_name?: string;
    real_name?: string;
    email?: string;
  };
};

type SlackChannel = {
  id?: string;
  name?: string;
  is_archived?: boolean;
  is_private?: boolean;
};

type SlackListUsersResponse = {
  members?: SlackUser[];
  response_metadata?: { next_cursor?: string };
};

type SlackListChannelsResponse = {
  channels?: SlackChannel[];
  response_metadata?: { next_cursor?: string };
};

type SlackAuthTestResponse = {
  ok?: boolean;
  user_id?: string;
  user?: string;
  team_id?: string;
  team?: string;
};

function resolveReadToken(params: DirectoryConfigParams): string | undefined {
  const account = resolveSlackAccount({ cfg: params.cfg, accountId: params.accountId });
  return account.userToken ?? account.botToken?.trim();
}

function normalizeQuery(value?: string | null): string {
  return normalizeLowercaseStringOrEmpty(value);
}

function buildUserRank(user: SlackUser): number {
  let rank = 0;
  if (!user.deleted) {
    rank += 2;
  }
  if (!user.is_bot && !user.is_app_user) {
    rank += 1;
  }
  return rank;
}

function buildChannelRank(channel: SlackChannel): number {
  return channel.is_archived ? 0 : 1;
}

function slackUserToDirectoryEntry(
  user: SlackUser,
  fallback?: { id?: string; name?: string },
): ChannelDirectoryEntry | null {
  const id = normalizeOptionalString(user.id) ?? normalizeOptionalString(fallback?.id);
  if (!id) {
    return null;
  }
  const handle = normalizeOptionalString(user.name) ?? normalizeOptionalString(fallback?.name);
  const display =
    normalizeOptionalString(user.profile?.display_name) ||
    normalizeOptionalString(user.profile?.real_name) ||
    normalizeOptionalString(user.real_name) ||
    handle;
  return {
    kind: "user",
    id: `user:${id}`,
    name: display || undefined,
    handle: handle ? `@${handle}` : undefined,
    rank: buildUserRank(user),
    raw: user,
  };
}

export async function getSlackDirectorySelfLive(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry | null> {
  const token = resolveReadToken(params);
  if (!token) {
    return null;
  }
  const client = createSlackWebClient(token);
  const auth = (await client.auth.test()) as SlackAuthTestResponse;
  const userId = normalizeOptionalString(auth.user_id);
  if (!userId) {
    return null;
  }
  try {
    const info = (await client.users.info({ user: userId })) as { user?: SlackUser };
    return slackUserToDirectoryEntry(info.user ?? {}, { id: userId, name: auth.user });
  } catch {
    return slackUserToDirectoryEntry(
      { id: userId, name: auth.user },
      { id: userId, name: auth.user },
    );
  }
}

export async function listSlackDirectoryPeersLive(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const token = resolveReadToken(params);
  if (!token) {
    return [];
  }
  const client = createSlackWebClient(token);
  const query = normalizeQuery(params.query);
  const members: SlackUser[] = [];
  let cursor: string | undefined;

  do {
    const res = (await client.users.list({
      limit: 200,
      cursor,
    })) as SlackListUsersResponse;
    if (Array.isArray(res.members)) {
      members.push(...res.members);
    }
    const next = res.response_metadata?.next_cursor?.trim();
    cursor = next ? next : undefined;
  } while (cursor);

  const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : undefined;
  const rows: ChannelDirectoryEntry[] = [];
  for (const member of members) {
    if (query) {
      const name = normalizeOptionalLowercaseString(
        member.profile?.display_name || member.profile?.real_name || member.real_name,
      );
      const handle = normalizeOptionalLowercaseString(member.name);
      const email = normalizeOptionalLowercaseString(member.profile?.email);
      if (!name?.includes(query) && !handle?.includes(query) && !email?.includes(query)) {
        continue;
      }
    }
    const entry = slackUserToDirectoryEntry(member);
    if (!entry) {
      continue;
    }
    rows.push(entry);
    if (limit && rows.length >= limit) {
      break;
    }
  }
  return rows;
}

export async function listSlackDirectoryGroupsLive(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const token = resolveReadToken(params);
  if (!token) {
    return [];
  }
  const client = createSlackWebClient(token);
  const query = normalizeQuery(params.query);
  const channels: SlackChannel[] = [];
  let cursor: string | undefined;

  do {
    const res = (await client.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: false,
      limit: 1000,
      cursor,
    })) as SlackListChannelsResponse;
    if (Array.isArray(res.channels)) {
      channels.push(...res.channels);
    }
    const next = res.response_metadata?.next_cursor?.trim();
    cursor = next ? next : undefined;
  } while (cursor);

  const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : undefined;
  const rows: ChannelDirectoryEntry[] = [];
  for (const channel of channels) {
    const normalizedName = normalizeOptionalLowercaseString(channel.name);
    if (query && !normalizedName?.includes(query)) {
      continue;
    }
    const id = channel.id?.trim();
    const name = channel.name?.trim();
    if (!id || !name) {
      continue;
    }
    rows.push({
      kind: "group",
      id: `channel:${id}`,
      name,
      handle: `#${name}`,
      rank: buildChannelRank(channel),
      raw: channel,
    });
    if (limit && rows.length >= limit) {
      break;
    }
  }
  return rows;
}
