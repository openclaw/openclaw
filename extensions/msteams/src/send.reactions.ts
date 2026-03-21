import type { OpenClawConfig } from "../runtime-api.js";
import { fetchGraphJson, resolveGraphToken } from "./graph.js";
import { normalizeMSTeamsConversationId } from "./inbound.js";
import { getMSTeamsRuntime } from "./runtime.js";

/** Teams native reaction type names. */
const UNICODE_TO_TEAMS_REACTION: Record<string, string> = {
  "👍": "like",
  "❤️": "heart",
  "😆": "laugh",
  "😮": "surprised",
  "😢": "sad",
  "😡": "angry",
};

/**
 * Map a Unicode emoji or Teams reaction name to the Teams API reaction type.
 * Falls back to the original value if not recognized.
 */
function resolveTeamsReactionType(emoji: string): string {
  const trimmed = emoji.trim();
  // If it's already a Teams native type, use it directly.
  if (/^(like|heart|laugh|surprised|sad|angry)$/.test(trimmed)) {
    return trimmed;
  }
  return UNICODE_TO_TEAMS_REACTION[trimmed] ?? trimmed;
}

/**
 * Detect whether this is a Graph-compatible chat/channel ID.
 * Bot Framework personal DM IDs (a:xxx / 8:orgid:xxx) cannot be used with Graph
 * /chats endpoints; only 19:xxx@thread.* IDs are valid there.
 */
function isGraphCompatibleConversationId(conversationId: string): boolean {
  return conversationId.startsWith("19:") || conversationId.includes("@thread");
}

export type ReactMessageMSTeamsParams = {
  /** Full config (for credentials) */
  cfg: OpenClawConfig;
  /** Conversation ID or user ID to address */
  to: string;
  /** Activity/message ID to react to */
  activityId: string;
  /** Emoji or Teams reaction type (like, heart, laugh, surprised, sad, angry) */
  emoji: string;
};

export type ReactMessageMSTeamsResult = {
  ok: true;
};

/**
 * Add a reaction to an MS Teams message via the Graph API.
 *
 * MS Teams Bot Framework does not expose a "send reaction" verb; outbound reactions
 * must go through the Graph API `/chats/{chatId}/messages/{messageId}/reactions`.
 * This requires the `ChatMessage.Send` or `Chat.ReadWrite` application permission.
 *
 * Note: Only conversations with Graph-compatible IDs (19:xxx@thread.*) are supported.
 * Personal DM conversations with Bot Framework IDs (a:xxx) cannot use this endpoint
 * without first resolving the Graph chat ID, which is not cached here.
 */
export async function reactMessageMSTeams(
  params: ReactMessageMSTeamsParams,
): Promise<ReactMessageMSTeamsResult> {
  const { cfg, to, activityId, emoji } = params;
  const core = getMSTeamsRuntime();
  const log = core.logging.getChildLogger({ name: "msteams:react" });

  const conversationId = normalizeMSTeamsConversationId(to.trim());
  if (!isGraphCompatibleConversationId(conversationId)) {
    log.warn?.(
      "MS Teams reactions via Graph API require a 19:xxx@thread conversation ID; " +
        "Bot Framework personal DM IDs are not supported",
      { conversationId },
    );
    throw new Error(
      `MS Teams reaction requires a Graph-compatible conversation ID (got: ${conversationId}). ` +
        "Personal DM conversations must be addressed via their 19:xxx@thread.* chat ID.",
    );
  }

  const reactionType = resolveTeamsReactionType(emoji);
  const token = await resolveGraphToken(cfg);

  // POST /chats/{chatId}/messages/{messageId}/reactions
  const path = `/chats/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(activityId)}/reactions`;
  await fetchGraphJson<unknown>({
    token,
    path,
    method: "POST",
    body: { reactionType },
  });

  log.debug?.("reaction added", { conversationId, activityId, reactionType });
  return { ok: true };
}

export type RemoveReactionMSTeamsParams = {
  /** Full config (for credentials) */
  cfg: OpenClawConfig;
  /** Conversation ID or user ID to address */
  to: string;
  /** Activity/message ID to remove reaction from */
  activityId: string;
  /** Emoji or Teams reaction type to remove */
  emoji: string;
};

/**
 * Remove a reaction from an MS Teams message via the Graph API.
 *
 * Uses DELETE /chats/{chatId}/messages/{messageId}/reactions/{reactionType}.
 */
export async function removeReactionMSTeams(
  params: RemoveReactionMSTeamsParams,
): Promise<ReactMessageMSTeamsResult> {
  const { cfg, to, activityId, emoji } = params;
  const core = getMSTeamsRuntime();
  const log = core.logging.getChildLogger({ name: "msteams:react" });

  const conversationId = normalizeMSTeamsConversationId(to.trim());
  if (!isGraphCompatibleConversationId(conversationId)) {
    log.warn?.("MS Teams reactions via Graph API require a 19:xxx@thread conversation ID", {
      conversationId,
    });
    throw new Error(
      `MS Teams reaction requires a Graph-compatible conversation ID (got: ${conversationId}).`,
    );
  }

  const reactionType = resolveTeamsReactionType(emoji);
  const token = await resolveGraphToken(cfg);

  // DELETE /chats/{chatId}/messages/{messageId}/reactions/{reactionType}
  const path = `/chats/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(activityId)}/reactions/${encodeURIComponent(reactionType)}`;
  await fetchGraphJson<unknown>({
    token,
    path,
    method: "DELETE",
  });

  log.debug?.("reaction removed", { conversationId, activityId, reactionType });
  return { ok: true };
}
