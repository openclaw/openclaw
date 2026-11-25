import type { WebClient } from "@slack/web-api";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { fetchSlackChannelListPage, type SlackConversationListType } from "./cursor-pages.js";
import { enrichSlackWebApiError } from "./errors.js";

export type SlackConversationListOptions = {
  types: readonly SlackConversationListType[];
  includeArchived: boolean;
  limit: number;
  cursor?: string;
};

export type SlackTokenWorkspace = { teamId?: string; enterpriseInstall: boolean };

export async function resolveSlackTokenWorkspaceWithClient(
  client: WebClient,
): Promise<SlackTokenWorkspace> {
  const auth = await client.auth.test();
  const teamId = normalizeOptionalString(auth.team_id);
  return { ...(teamId ? { teamId } : {}), enterpriseInstall: auth.is_enterprise_install === true };
}

export type SlackConversationSummary = {
  id: string;
  name?: string;
  type: SlackConversationListType;
  isMember: boolean;
  isArchived: boolean;
  userId?: string;
  topic?: string;
  purpose?: string;
};

export async function listSlackConversationsWithClient(
  client: WebClient,
  opts: SlackConversationListOptions,
): Promise<{ conversations: SlackConversationSummary[]; nextCursor?: string }> {
  const result = await fetchSlackChannelListPage(client, opts.cursor, {
    types: opts.types.join(","),
    excludeArchived: !opts.includeArchived,
    limit: opts.limit,
  }).catch((err: unknown) => {
    // Name a missing *:read scope instead of Slack's bare error code.
    throw enrichSlackWebApiError(err);
  });
  const conversations = (result.channels ?? []).flatMap((channel): SlackConversationSummary[] => {
    const id = normalizeOptionalString(channel.id);
    if (!id) {
      return [];
    }
    const name = normalizeOptionalString(channel.name);
    const userId = normalizeOptionalString(channel.user);
    const topic = normalizeOptionalString(channel.topic?.value);
    const purpose = normalizeOptionalString(channel.purpose?.value);
    const type = channel.is_im
      ? "im"
      : channel.is_mpim
        ? "mpim"
        : channel.is_private || channel.is_group
          ? "private_channel"
          : "public_channel";
    return [
      {
        id,
        ...(name ? { name } : {}),
        type,
        // Slack lists DMs and group DMs only for participants and omits is_member on DMs.
        isMember: type === "im" || type === "mpim" || channel.is_member === true,
        isArchived: channel.is_archived === true,
        ...(userId ? { userId } : {}),
        ...(topic ? { topic } : {}),
        ...(purpose ? { purpose } : {}),
      },
    ];
  });
  const nextCursor = normalizeOptionalString(result.response_metadata?.next_cursor);
  return { conversations, ...(nextCursor ? { nextCursor } : {}) };
}
