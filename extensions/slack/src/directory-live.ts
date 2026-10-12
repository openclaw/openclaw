import type { UsersListResponse, WebClient } from "@slack/web-api";
import type {
  ChannelDirectoryEntry,
  DirectoryConfigParams,
} from "openclaw/plugin-sdk/directory-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveSlackAccount } from "./accounts.js";
import { createSlackLookupClient } from "./client.js";
import { collectSlackCursorPages, fetchSlackChannelListPage } from "./cursor-pages.js";

type SlackUser = NonNullable<UsersListResponse["members"]>[number];

function createSlackDirectoryClient(params: DirectoryConfigParams) {
  const account = resolveSlackAccount({ cfg: params.cfg, accountId: params.accountId });
  const token = account.userToken ?? account.botToken?.trim();
  return token ? createSlackLookupClient(token) : null;
}

function buildUserRank(user: SlackUser): number {
  return (user.deleted ? 0 : 2) + (user.is_bot || user.is_app_user ? 0 : 1);
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
  const client = createSlackDirectoryClient(params);
  if (!client) {
    return null;
  }
  const auth = await client.auth.test();
  const userId = normalizeOptionalString(auth.user_id);
  if (!userId) {
    return null;
  }
  try {
    const info = await client.users.info({ user: userId });
    return slackUserToDirectoryEntry(info.user ?? {}, { id: userId, name: auth.user });
  } catch {
    return slackUserToDirectoryEntry({ id: userId, name: auth.user });
  }
}

function createSlackDirectoryLister<T>(options: {
  fetchRows: (client: WebClient) => Promise<T[]>;
  searchValues: (row: T) => unknown[];
  toEntry: (row: T) => ChannelDirectoryEntry | null;
}) {
  return async (params: DirectoryConfigParams): Promise<ChannelDirectoryEntry[]> => {
    const client = createSlackDirectoryClient(params);
    if (!client) {
      return [];
    }
    const query = normalizeLowercaseStringOrEmpty(params.query);
    const rows = (await options.fetchRows(client))
      .filter((row) => {
        const candidates = options
          .searchValues(row)
          .map(normalizeOptionalLowercaseString)
          .filter(Boolean);
        return !query || candidates.some((candidate) => candidate?.includes(query));
      })
      .map(options.toEntry)
      .filter((entry) => entry !== null);
    return typeof params.limit === "number" && params.limit > 0
      ? rows.slice(0, params.limit)
      : rows;
  };
}

export const listSlackDirectoryPeersLive = createSlackDirectoryLister({
  fetchRows: (client) =>
    collectSlackCursorPages({
      fetchPage: (cursor) => client.users.list({ limit: 200, cursor }),
      collectPageItems: (res) => (Array.isArray(res.members) ? res.members : []),
    }),
  searchValues: (member) => [
    member.profile?.display_name || member.profile?.real_name || member.real_name,
    member.name,
    member.profile?.email,
  ],
  toEntry: (member) => slackUserToDirectoryEntry(member),
});

export const listSlackDirectoryGroupsLive = createSlackDirectoryLister({
  fetchRows: (client) =>
    collectSlackCursorPages({
      fetchPage: (cursor) => fetchSlackChannelListPage(client, cursor),
      collectPageItems: (res) => (Array.isArray(res.channels) ? res.channels : []),
    }),
  searchValues: (channel) => [channel.name],
  toEntry: (channel) => {
    const id = channel.id?.trim();
    const name = channel.name?.trim();
    return id && name
      ? {
          kind: "group",
          id: `channel:${id}`,
          name,
          handle: `#${name}`,
          rank: channel.is_archived ? 0 : 1,
          raw: channel,
        }
      : null;
  },
});
