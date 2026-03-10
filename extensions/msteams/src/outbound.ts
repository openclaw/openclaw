import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/msteams";
import { createMSTeamsPollStoreFs } from "./polls.js";
import { getMSTeamsRuntime } from "./runtime.js";
import { sendAdaptiveCardMSTeams, sendMessageMSTeams, sendPollMSTeams } from "./send.js";

/**
 * Extract an Adaptive Card from marker comments embedded in reply text.
 * Mirrors the regex in src/cards/parse.ts but kept inline to avoid
 * a cross-workspace import (extensions cannot import from src/ directly).
 */
const AC_CARD_RE = /<!--adaptive-card-->([\s\S]*?)<!--\/adaptive-card-->/;
const AC_MARKERS_RE =
  /<!--adaptive-card-->[\s\S]*?<!--\/adaptive-card-->|<!--adaptive-card-data-->[\s\S]*?<!--\/adaptive-card-data-->/g;

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

/** Strip all adaptive card markers, returning only the fallback text. */
function stripCardMarkers(text: string): string {
  return text.replace(AC_MARKERS_RE, "").trim();
}

export const msteamsOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getMSTeamsRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  pollMaxOptions: 12,
  sendText: async ({ cfg, to, text, deps }) => {
    // Native adaptive card pass-through: Teams supports AC directly
    const hasMarkers = AC_CARD_RE.test(text);
    const card = hasMarkers ? extractAdaptiveCard(text) : null;
    if (card) {
      const result = await sendAdaptiveCardMSTeams({ cfg, to, card });
      return { channel: "msteams", ...result };
    }
    // Strip markers to avoid leaking raw JSON if card extraction failed
    if (hasMarkers) {
      text = stripCardMarkers(text);
    }

    const send = deps?.sendMSTeams ?? ((to, text) => sendMessageMSTeams({ cfg, to, text }));
    const result = await send(to, text);
    return { channel: "msteams", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, deps }) => {
    const send =
      deps?.sendMSTeams ??
      ((to, text, opts) =>
        sendMessageMSTeams({
          cfg,
          to,
          text,
          mediaUrl: opts?.mediaUrl,
          mediaLocalRoots: opts?.mediaLocalRoots,
        }));
    const result = await send(to, text, { mediaUrl, mediaLocalRoots });
    return { channel: "msteams", ...result };
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
};
