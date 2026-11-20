import type { WebClient } from "@slack/web-api";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { fetchSlackChannelListPage, type SlackConversationListType } from "./cursor-pages.js";
import { enrichSlackWebApiError } from "./errors.js";

export type SlackConversationListOptions = {
  types: readonly SlackConversationListType[];
  includeArchived: boolean;
  limit: number;
  cursor?: string;
  /** Workspace already known for this account; otherwise auth.test names it. */
  knownTeamId?: string;
};

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
): Promise<{ teamId?: string; conversations: SlackConversationSummary[]; nextCursor?: string }> {
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
  const teamId =
    normalizeOptionalString(opts.knownTeamId) ??
    normalizeOptionalString((await client.auth.test()).team_id);
  return { ...(teamId ? { teamId } : {}), conversations, ...(nextCursor ? { nextCursor } : {}) };
}
