import type { BskyAgent } from "@atproto/api";
import { chatApiGet, chatApiPost } from "./auth.js";

const LXM_SEND_MESSAGE = "chat.bsky.convo.sendMessage";
const LXM_GET_CONVO_FOR_MEMBERS = "chat.bsky.convo.getConvoForMembers";

type GetConvoForMembersResponse = {
  convo: { id: string };
};

type SendMessageResponse = {
  id: string;
  rev: string;
};

/**
 * Resolve a conversation ID from a DID when the caller only knows the peer DID.
 * Bluesky DMs are keyed by convoId; this creates or retrieves the convo for a 1:1 pair.
 */
async function resolveConvoId(agent: BskyAgent, target: string): Promise<string> {
  if (!target.startsWith("did:")) {
    // Already a convoId
    return target;
  }
  const data = await chatApiGet<GetConvoForMembersResponse>(agent, LXM_GET_CONVO_FOR_MEMBERS, {
    members: target,
  });
  return data.convo.id;
}

/**
 * Send a text message to a Bluesky DM conversation.
 *
 * @param agent - Authenticated BskyAgent for the sending account.
 * @param target - Either a convoId or a DID (resolved to convoId automatically).
 * @param text - The message text to send.
 * @returns The convoId used and the new message ID.
 */
export async function sendBlueskyMessage(
  agent: BskyAgent,
  target: string,
  text: string,
): Promise<{ convoId: string; messageId: string }> {
  const convoId = await resolveConvoId(agent, target);
  const data = await chatApiPost<SendMessageResponse>(agent, LXM_SEND_MESSAGE, {
    convoId,
    message: { text },
  });
  return { convoId, messageId: data.id };
}
