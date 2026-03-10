import { resolveOutboundSendDep } from "openclaw/plugin-sdk/channel-runtime";
import { createAttachedChannelResultAdapter } from "openclaw/plugin-sdk/channel-send-result";
import type { ChannelOutboundAdapter } from "../runtime-api.js";
import { createMSTeamsPollStoreFs } from "./polls.js";
import { getMSTeamsRuntime } from "./runtime.js";
import { sendAdaptiveCardMSTeams, sendMessageMSTeams, sendPollMSTeams } from "./send.js";

/**
 * Extract an Adaptive Card from marker comments embedded in reply text.
 * Mirrors the regex in src/cards/parse.ts but kept inline to avoid
 * a cross-workspace import (extensions cannot import from src/ directly).
 */
const AC_CARD_RE = /<!--adaptive-card-->([\s\S]*?)<!--\/adaptive-card-->/;

function extractAdaptiveCard(text: string): Record<string, unknown> | null {
  const m = AC_CARD_RE.exec(text);
  if (!m) {
    return null;
  }
  try {
    const parsed = JSON.parse(m[1].trim());
    if (parsed?.type === "AdaptiveCard") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // malformed JSON
  }
  return null;
}

export const msteamsOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getMSTeamsRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  pollMaxOptions: 12,
  ...createAttachedChannelResultAdapter({
    channel: "msteams",
    sendText: async ({ cfg, to, text, deps }) => {
      // Native adaptive card pass-through: Teams supports AC directly
      const card = extractAdaptiveCard(text);
      if (card) {
        return await sendAdaptiveCardMSTeams({ cfg, to, card });
      }

      type SendFn = (
        to: string,
        text: string,
      ) => Promise<{ messageId: string; conversationId: string }>;
      const send =
        resolveOutboundSendDep<SendFn>(deps, "msteams") ??
        ((to, text) => sendMessageMSTeams({ cfg, to, text }));
      return await send(to, text);
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, deps }) => {
      type SendFn = (
        to: string,
        text: string,
        opts?: { mediaUrl?: string; mediaLocalRoots?: readonly string[] },
      ) => Promise<{ messageId: string; conversationId: string }>;
      const send =
        resolveOutboundSendDep<SendFn>(deps, "msteams") ??
        ((to, text, opts) =>
          sendMessageMSTeams({
            cfg,
            to,
            text,
            mediaUrl: opts?.mediaUrl,
            mediaLocalRoots: opts?.mediaLocalRoots,
          }));
      return await send(to, text, { mediaUrl, mediaLocalRoots });
    },
    sendPoll: async ({ cfg, to, poll }) => {
      const maxSelections = poll.maxSelections ?? 1;
      const result = await sendPollMSTeams({
        cfg,
        to,
        question: poll.question,
        options: poll.options,
        maxSelections,
      });
      const pollStore = createMSTeamsPollStoreFs();
      await pollStore.createPoll({
        id: result.pollId,
        question: poll.question,
        options: poll.options,
        maxSelections,
        createdAt: new Date().toISOString(),
        conversationId: result.conversationId,
        messageId: result.messageId,
        votes: {},
      });
      return result;
    },
  }),
};
