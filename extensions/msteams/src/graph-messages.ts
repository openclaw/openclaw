import type { OpenClawConfig } from "../runtime-api.js";
import { createMSTeamsConversationStoreFs } from "./conversation-store-fs.js";
import { looksLikeGraphTeamId, resolveTeamGroupId } from "./graph-thread.js";
import {
  type GraphResponse,
  deleteGraphRequest,
  escapeOData,
  fetchGraphJson,
  postGraphBetaJson,
  postGraphJson,
  resolveGraphToken,
} from "./graph.js";

type GraphMessageBody = {
  content?: string;
  contentType?: string;
};

type GraphMessageFrom = {
  user?: { id?: string; displayName?: string };
  application?: { id?: string; displayName?: string };
};

type GraphMessage = {
  id?: string;
  body?: GraphMessageBody;
  from?: GraphMessageFrom;
  createdDateTime?: string;
};

type GraphPinnedMessage = {
  id?: string;
  message?: GraphMessage;
};

type GraphPinnedMessagesResponse = {
  value?: GraphPinnedMessage[];
};

type ResolvedGraphConversationTarget =
  | {
      kind: "chat";
      conversationId: string;
      basePath: string;
      chatId: string;
    }
  | {
      kind: "channel";
      conversationId: string;
      basePath: string;
      teamId: string;
      channelId: string;
    };

/**
 * Strip common target prefixes (`conversation:`, `user:`) so raw
 * conversation IDs can be used directly in Graph paths.
 */
function stripTargetPrefix(raw: string): string {
  const trimmed = raw.trim();
  if (/^conversation:/i.test(trimmed)) {
    return trimmed.slice("conversation:".length).trim();
  }
  if (/^user:/i.test(trimmed)) {
    return trimmed.slice("user:".length).trim();
  }
  return trimmed;
}

async function resolveGraphConversationTarget(params: {
  to: string;
  token: string;
}): Promise<ResolvedGraphConversationTarget> {
  const trimmed = params.to.trim();
  const store = createMSTeamsConversationStoreFs();

  if (/^user:/i.test(trimmed)) {
    const userId = stripTargetPrefix(trimmed);
    const found = await store.findPreferredDmByUserId(userId);
    if (!found) {
      throw new Error(
        `No conversation found for user:${userId}. ` +
          "The bot must receive a message from this user before Graph API operations work.",
      );
    }

    // Bot Framework DM conversation ids are not always valid Graph chat ids.
    // Prefer the cached Graph-native id when we have it; only fall back to the
    // stored conversation id when it already looks like a Graph chat id.
    if (found.reference.graphChatId) {
      return {
        kind: "chat",
        conversationId: found.conversationId,
        chatId: found.reference.graphChatId,
        basePath: `/chats/${encodeURIComponent(found.reference.graphChatId)}`,
      };
    }
    if (found.conversationId.startsWith("19:")) {
      return {
        kind: "chat",
        conversationId: found.conversationId,
        chatId: found.conversationId,
        basePath: `/chats/${encodeURIComponent(found.conversationId)}`,
      };
    }
    throw new Error(
      `Conversation for user:${userId} uses a Bot Framework ID (${found.conversationId}) ` +
        "that Graph API does not accept. Send a message to this user first so the Graph chat ID is cached.",
    );
  }

  const cleaned = stripTargetPrefix(trimmed);
  if (cleaned.includes("/")) {
    // Keep support for explicit team/channel targets so callers can address a
    // channel directly without first relying on a stored conversation record.
    const [teamId, channelId] = cleaned.split("/", 2);
    if (!teamId?.trim() || !channelId?.trim()) {
      throw new Error(`Invalid Teams channel target: ${params.to}`);
    }
    // Channel targets carry the Teams/Bot Framework team key. Resolve it to
    // the Graph team/group id before building `/teams/{id}/channels/{id}`.
    const resolvedTeamId = await resolveTeamGroupId(params.token, teamId.trim());
    if (!looksLikeGraphTeamId(resolvedTeamId)) {
      throw new Error(`Teams channel target ${params.to} did not resolve to a Graph team id.`);
    }
    return {
      kind: "channel",
      conversationId: cleaned,
      teamId: resolvedTeamId,
      channelId: channelId.trim(),
      basePath: `/teams/${encodeURIComponent(resolvedTeamId)}/channels/${encodeURIComponent(channelId.trim())}`,
    };
  }

  const reference = await store.get(cleaned);
  const conversationType = reference?.conversation?.conversationType?.toLowerCase();
  if (conversationType === "channel") {
    const teamId = reference?.teamId?.trim();
    const channelId = reference?.graphChannelId?.trim();
    if (!teamId || !channelId) {
      throw new Error(
        `Conversation ${cleaned} is a Teams channel but missing teamId or graphChannelId in the conversation store.`,
      );
    }

    // The normalized plugin target for Teams channels stays as
    // `conversation:<bot-framework-conversation-id>`. When Graph needs a real
    // channel path later, we must recover it from the stored Teams metadata
    // captured on inbound traffic rather than guessing from the normalized id.
    // Stored channel metadata preserves the inbound Teams team key. Graph
    // channel APIs still need the Graph team/group id, so translate here too.
    const resolvedTeamId = await resolveTeamGroupId(params.token, teamId);
    if (!looksLikeGraphTeamId(resolvedTeamId)) {
      throw new Error(`Conversation ${cleaned} is missing a usable Graph team id.`);
    }
    return {
      kind: "channel",
      conversationId: cleaned,
      teamId: resolvedTeamId,
      channelId,
      basePath: `/teams/${encodeURIComponent(resolvedTeamId)}/channels/${encodeURIComponent(channelId)}`,
    };
  }

  // Non-channel conversations keep using the chat path. For group chats and
  // cached DM chats, the normalized conversation id is the Graph-addressable id.
  return {
    kind: "chat",
    conversationId: cleaned,
    chatId: cleaned,
    basePath: `/chats/${encodeURIComponent(cleaned)}`,
  };
}

export type GetMessageMSTeamsParams = {
  cfg: OpenClawConfig;
  to: string;
  messageId: string;
};

export type GetMessageMSTeamsResult = {
  id: string;
  text: string | undefined;
  from: GraphMessageFrom | undefined;
  createdAt: string | undefined;
};

/**
 * Retrieve a single message by ID from a chat or channel via Graph API.
 */
export async function getMessageMSTeams(
  params: GetMessageMSTeamsParams,
): Promise<GetMessageMSTeamsResult> {
  const token = await resolveGraphToken(params.cfg);
  const target = await resolveGraphConversationTarget({ to: params.to, token });
  const path = `${target.basePath}/messages/${encodeURIComponent(params.messageId)}`;
  const msg = await fetchGraphJson<GraphMessage>({ token, path });
  return {
    id: msg.id ?? params.messageId,
    text: msg.body?.content,
    from: msg.from,
    createdAt: msg.createdDateTime,
  };
}

export type PinMessageMSTeamsParams = {
  cfg: OpenClawConfig;
  to: string;
  messageId: string;
};

/**
 * Pin a message in a chat conversation via Graph API.
 * Channel pinning uses a different endpoint (beta) handled separately.
 */
export async function pinMessageMSTeams(
  params: PinMessageMSTeamsParams,
): Promise<{ ok: true; pinnedMessageId?: string }> {
  const token = await resolveGraphToken(params.cfg);
  const conv = await resolveGraphConversationTarget({ to: params.to, token });

  if (conv.kind === "channel") {
    // Graph v1.0 doesn't have channel pin — use the pinnedMessages pattern on chat
    // For channels, attempt POST to pinnedMessages (same shape, may require beta)
    await postGraphJson<unknown>({
      token,
      path: `${conv.basePath}/pinnedMessages`,
      body: { message: { id: params.messageId } },
    });
    return { ok: true };
  }

  const result = await postGraphJson<{ id?: string }>({
    token,
    path: `${conv.basePath}/pinnedMessages`,
    body: { message: { id: params.messageId } },
  });
  return { ok: true, pinnedMessageId: result.id };
}

export type UnpinMessageMSTeamsParams = {
  cfg: OpenClawConfig;
  to: string;
  /** The pinned-message resource ID returned by pin or list-pins (not the message ID). */
  pinnedMessageId: string;
};

/**
 * Unpin a message in a chat conversation via Graph API.
 * `pinnedMessageId` is the pinned-message resource ID (from pin or list-pins),
 * not the underlying chat message ID.
 */
export async function unpinMessageMSTeams(
  params: UnpinMessageMSTeamsParams,
): Promise<{ ok: true }> {
  const token = await resolveGraphToken(params.cfg);
  const conv = await resolveGraphConversationTarget({ to: params.to, token });
  const path = `${conv.basePath}/pinnedMessages/${encodeURIComponent(params.pinnedMessageId)}`;
  await deleteGraphRequest({ token, path });
  return { ok: true };
}

export type ListPinsMSTeamsParams = {
  cfg: OpenClawConfig;
  to: string;
};

export type ListPinsMSTeamsResult = {
  pins: Array<{ id: string; pinnedMessageId: string; messageId?: string; text?: string }>;
};

/**
 * List all pinned messages in a chat conversation via Graph API.
 */
export async function listPinsMSTeams(
  params: ListPinsMSTeamsParams,
): Promise<ListPinsMSTeamsResult> {
  const token = await resolveGraphToken(params.cfg);
  const conv = await resolveGraphConversationTarget({ to: params.to, token });
  const path = `${conv.basePath}/pinnedMessages?$expand=message`;
  const res = await fetchGraphJson<GraphPinnedMessagesResponse>({ token, path });
  const pins = (res.value ?? []).map((pin) => ({
    id: pin.id ?? "",
    pinnedMessageId: pin.id ?? "",
    messageId: pin.message?.id,
    text: pin.message?.body?.content,
  }));
  return { pins };
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

export const TEAMS_REACTION_TYPES = [
  "like",
  "heart",
  "laugh",
  "surprised",
  "sad",
  "angry",
] as const;
export type TeamsReactionType = (typeof TEAMS_REACTION_TYPES)[number];

type GraphReaction = {
  reactionType?: string;
  user?: { id?: string; displayName?: string };
  createdDateTime?: string;
};

type GraphMessageWithReactions = GraphMessage & {
  reactions?: GraphReaction[];
};

export type ReactMessageMSTeamsParams = {
  cfg: OpenClawConfig;
  to: string;
  messageId: string;
  reactionType: string;
};

export type ListReactionsMSTeamsParams = {
  cfg: OpenClawConfig;
  to: string;
  messageId: string;
};

export type ReactionSummary = {
  reactionType: string;
  count: number;
  users: Array<{ id: string; displayName?: string }>;
};

export type ListReactionsMSTeamsResult = {
  reactions: ReactionSummary[];
};

function validateReactionType(raw: string): TeamsReactionType {
  const normalized = raw.toLowerCase().trim();
  if (!TEAMS_REACTION_TYPES.includes(normalized as TeamsReactionType)) {
    throw new Error(
      `Invalid reaction type "${raw}". Valid types: ${TEAMS_REACTION_TYPES.join(", ")}`,
    );
  }
  return normalized as TeamsReactionType;
}

/**
 * Add an emoji reaction to a message via Graph API (beta).
 */
export async function reactMessageMSTeams(
  params: ReactMessageMSTeamsParams,
): Promise<{ ok: true }> {
  const reactionType = validateReactionType(params.reactionType);
  const token = await resolveGraphToken(params.cfg);
  const { basePath } = await resolveGraphConversationTarget({ to: params.to, token });
  const path = `${basePath}/messages/${encodeURIComponent(params.messageId)}/setReaction`;
  await postGraphBetaJson<unknown>({ token, path, body: { reactionType } });
  return { ok: true };
}

/**
 * Remove an emoji reaction from a message via Graph API (beta).
 */
export async function unreactMessageMSTeams(
  params: ReactMessageMSTeamsParams,
): Promise<{ ok: true }> {
  const reactionType = validateReactionType(params.reactionType);
  const token = await resolveGraphToken(params.cfg);
  const { basePath } = await resolveGraphConversationTarget({ to: params.to, token });
  const path = `${basePath}/messages/${encodeURIComponent(params.messageId)}/unsetReaction`;
  await postGraphBetaJson<unknown>({ token, path, body: { reactionType } });
  return { ok: true };
}

/**
 * List reactions on a message, grouped by type.
 * Uses Graph v1.0 (reactions are included in the message resource).
 */
export async function listReactionsMSTeams(
  params: ListReactionsMSTeamsParams,
): Promise<ListReactionsMSTeamsResult> {
  const token = await resolveGraphToken(params.cfg);
  const { basePath } = await resolveGraphConversationTarget({ to: params.to, token });
  const path = `${basePath}/messages/${encodeURIComponent(params.messageId)}`;
  const msg = await fetchGraphJson<GraphMessageWithReactions>({ token, path });

  const grouped = new Map<string, Array<{ id: string; displayName?: string }>>();
  for (const reaction of msg.reactions ?? []) {
    const type = reaction.reactionType ?? "unknown";
    if (!grouped.has(type)) {
      grouped.set(type, []);
    }
    if (reaction.user?.id) {
      grouped.get(type)!.push({
        id: reaction.user.id,
        displayName: reaction.user.displayName,
      });
    }
  }

  const reactions: ReactionSummary[] = Array.from(grouped.entries()).map(([type, users]) => ({
    reactionType: type,
    count: users.length,
    users,
  }));

  return { reactions };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export type SearchMessagesMSTeamsParams = {
  cfg: OpenClawConfig;
  to: string;
  query: string;
  from?: string;
  limit?: number;
};

export type SearchMessagesMSTeamsResult = {
  messages: Array<{
    id: string;
    text: string | undefined;
    from: GraphMessageFrom | undefined;
    createdAt: string | undefined;
  }>;
};

const SEARCH_DEFAULT_LIMIT = 25;
const SEARCH_MAX_LIMIT = 50;

/**
 * Search messages in a chat or channel by content via Graph API.
 * Uses `$search` for full-text body search and optional `$filter` for sender.
 */
export async function searchMessagesMSTeams(
  params: SearchMessagesMSTeamsParams,
): Promise<SearchMessagesMSTeamsResult> {
  const token = await resolveGraphToken(params.cfg);
  const { basePath } = await resolveGraphConversationTarget({ to: params.to, token });

  const rawLimit = params.limit ?? SEARCH_DEFAULT_LIMIT;
  const top = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), SEARCH_MAX_LIMIT)
    : SEARCH_DEFAULT_LIMIT;

  // Strip double quotes from the query to prevent OData $search injection
  const sanitizedQuery = params.query.replace(/"/g, "");

  // Build query string manually (not URLSearchParams) to preserve literal $
  // in OData parameter names, consistent with other Graph calls in this module.
  const parts = [`$search=${encodeURIComponent(`"${sanitizedQuery}"`)}`];
  parts.push(`$top=${top}`);
  if (params.from) {
    parts.push(
      `$filter=${encodeURIComponent(`from/user/displayName eq '${escapeOData(params.from)}'`)}`,
    );
  }

  const path = `${basePath}/messages?${parts.join("&")}`;
  // ConsistencyLevel: eventual is required by Graph API for $search queries
  const res = await fetchGraphJson<GraphResponse<GraphMessage>>({
    token,
    path,
    headers: { ConsistencyLevel: "eventual" },
  });

  const messages = (res.value ?? []).map((msg) => ({
    id: msg.id ?? "",
    text: msg.body?.content,
    from: msg.from,
    createdAt: msg.createdDateTime,
  }));

  return { messages };
}
