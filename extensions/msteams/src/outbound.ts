import {
  attachChannelToResult,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import { resolveInteractiveTextFallback } from "openclaw/plugin-sdk/interactive-runtime";
import { resolveOutboundSendDep } from "openclaw/plugin-sdk/outbound-runtime";
import {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequenceAndFinalize,
  sendTextMediaPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { chunkTextForOutbound, type ChannelOutboundAdapter } from "../runtime-api.js";
import { createMSTeamsPollStoreFs } from "./polls.js";
import { sendAdaptiveCardMSTeams, sendMessageMSTeams, sendPollMSTeams } from "./send.js";

/**
 * Build an Adaptive Card from interactive approval buttons.
 * Returns undefined if no buttons are found (caller should fall back to text).
 */
function buildApprovalAdaptiveCard(
  interactive: { blocks?: Array<{ type: string; buttons?: Array<{ label: string; value: string; style?: string }> }> } | undefined,
  text: string,
): Record<string, unknown> | undefined {
  const buttons = (interactive?.blocks ?? [])
    .filter((b) => b.type === "buttons")
    .flatMap((b) => b.buttons ?? []);
  if (buttons.length === 0) {
    return undefined;
  }

  return {
    type: "AdaptiveCard",
    version: "1.5",
    body: text ? [{ type: "TextBlock", text, wrap: true }] : [],
    actions: buttons.map((b) => ({
      type: "Action.Submit",
      title: b.label,
      style: b.style === "danger" ? "destructive" : b.style === "primary" || b.style === "success" ? "positive" : "default",
      data: {
        msteams: {
          type: "messageBack",
          text: b.value,
          displayText: b.label,
          value: { openclawApproval: b.value },
        },
      },
    })),
  };
}

export const msteamsOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  pollMaxOptions: 12,
  ...createAttachedChannelResultAdapter({
    channel: "msteams",
    sendText: async ({ cfg, to, text, deps }) => {
      type SendFn = (
        to: string,
        text: string,
      ) => Promise<{ messageId: string; conversationId: string }>;
      const send =
        resolveOutboundSendDep<SendFn>(deps, "msteams") ??
        ((to, text) => sendMessageMSTeams({ cfg, to, text }));
      return await send(to, text);
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, mediaReadFile, deps }) => {
      type SendFn = (
        to: string,
        text: string,
        opts?: {
          mediaUrl?: string;
          mediaLocalRoots?: readonly string[];
          mediaReadFile?: (filePath: string) => Promise<Buffer>;
        },
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
            mediaReadFile: opts?.mediaReadFile,
          }));
      return await send(to, text, { mediaUrl, mediaLocalRoots, mediaReadFile });
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
  sendPayload: async (ctx) => {
    const payload = {
      ...ctx.payload,
      text:
        resolveInteractiveTextFallback({
          text: ctx.payload.text,
          interactive: ctx.payload.interactive,
        }) ?? "",
    };

    // If a pre-built Teams card was supplied via channelData, send it directly.
    const teamsChannelData = payload.channelData?.msteams as
      | { card?: Record<string, unknown> }
      | undefined;
    if (teamsChannelData?.card) {
      const mediaUrls = resolvePayloadMediaUrls(payload);
      return attachChannelToResult(
        "msteams",
        await sendPayloadMediaSequenceAndFinalize({
          text: "",
          mediaUrls,
          send: async ({ text, mediaUrl }) =>
            await sendMessageMSTeams({
              cfg: ctx.cfg,
              to: ctx.to,
              text,
              mediaUrl,
            }),
          finalize: async () =>
            await sendAdaptiveCardMSTeams({
              cfg: ctx.cfg,
              to: ctx.to,
              card: teamsChannelData.card!,
            }),
        }),
      );
    }

    // Map interactive buttons to an Adaptive Card.
    const card = buildApprovalAdaptiveCard(payload.interactive, payload.text);
    if (!card) {
      // No interactive buttons — fall back to text+media delivery.
      return await sendTextMediaPayload({
        channel: "msteams",
        ctx: { ...ctx, payload },
        adapter: msteamsOutbound,
      });
    }

    // Send any media first, then finalize with the Adaptive Card.
    const mediaUrls = resolvePayloadMediaUrls(payload);
    return attachChannelToResult(
      "msteams",
      await sendPayloadMediaSequenceAndFinalize({
        text: "",
        mediaUrls,
        send: async ({ text, mediaUrl }) =>
          await sendMessageMSTeams({
            cfg: ctx.cfg,
            to: ctx.to,
            text,
            mediaUrl,
          }),
        finalize: async () =>
          await sendAdaptiveCardMSTeams({ cfg: ctx.cfg, to: ctx.to, card }),
      }),
    );
  },
};
