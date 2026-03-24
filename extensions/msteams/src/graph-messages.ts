import type { OpenClawConfig } from "../runtime-api.js";
import { deleteGraphRequest, fetchGraphJson, postGraphJson, resolveGraphToken } from "./graph.js";

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

/**
 * Resolve the Graph API path prefix for a conversation.
 * If `to` contains "/" it's a `teamId/channelId` (channel path),
 * otherwise it's a chat ID.
 */
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

function resolveConversationPath(to: string): {
  kind: "chat" | "channel";
  basePath: string;
  chatId?: string;
  teamId?: string;
  channelId?: string;
} {
  const cleaned = stripTargetPrefix(to);
  if (cleaned.includes("/")) {
    const [teamId, channelId] = cleaned.split("/", 2);
    return {
      kind: "channel",
      basePath: `/teams/${encodeURIComponent(teamId!)}/channels/${encodeURIComponent(channelId!)}`,
      teamId,
      channelId,
    };
  }
  return {
    kind: "chat",
    basePath: `/chats/${encodeURIComponent(cleaned)}`,
    chatId: cleaned,
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
  const { basePath } = resolveConversationPath(params.to);
  const path = `${basePath}/messages/${encodeURIComponent(params.messageId)}`;
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
  const conv = resolveConversationPath(params.to);

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
  const conv = resolveConversationPath(params.to);
  const path = `${conv.basePath}/pinnedMessages/${encodeURIComponent(params.pinnedMessageId)}`;
  await deleteGraphRequest({ token, path });
  return { ok: true };
}

export type ListPinsMSTeamsParams = {
  cfg: OpenClawConfig;
  to: string;
};

export type ListPinsMSTeamsResult = {
  pins: Array<{ pinnedMessageId: string; messageId?: string; text?: string }>;
};

/**
 * List all pinned messages in a chat conversation via Graph API.
 */
export async function listPinsMSTeams(
  params: ListPinsMSTeamsParams,
): Promise<ListPinsMSTeamsResult> {
  const token = await resolveGraphToken(params.cfg);
  const conv = resolveConversationPath(params.to);
  const path = `${conv.basePath}/pinnedMessages?$expand=message`;
  const res = await fetchGraphJson<GraphPinnedMessagesResponse>({ token, path });
  const pins = (res.value ?? []).map((pin) => ({
    pinnedMessageId: pin.id ?? "",
    messageId: pin.message?.id,
    text: pin.message?.body?.content,
  }));
  return { pins };
}
