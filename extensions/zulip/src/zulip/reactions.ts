import { zulipAddReaction, type ZulipClient } from "./client.js";

export async function reactEyes(client: ZulipClient, messageId: number): Promise<void> {
  // Zulip emoji_name for 👀 is "eyes".
  await zulipAddReaction(client, { messageId, emojiName: "eyes" });
}
