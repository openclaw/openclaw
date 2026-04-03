import {
  attachChannelToResult,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import {
  reduceInteractiveReply,
  renderInteractiveCommandFallback,
  resolveInteractiveActionId,
  resolveInteractiveTextFallback,
  type InteractiveReply,
} from "openclaw/plugin-sdk/interactive-runtime";
import { resolveOutboundSendDep } from "openclaw/plugin-sdk/outbound-runtime";
import type { ChannelOutboundAdapter } from "../runtime-api.js";
import { chunkTextForOutbound } from "../runtime-api.js";
import { createMSTeamsPollStoreFs } from "./polls.js";
import { sendAdaptiveCardMSTeams, sendMessageMSTeams, sendPollMSTeams } from "./send.js";

function buildMSTeamsInteractiveCard(params: {
  interactive: InteractiveReply;
  text?: string;
}): Record<string, unknown> {
  const body: Array<Record<string, unknown>> = [];
  const actions: Array<Record<string, unknown>> = [];
  let selectIndex = 0;

  reduceInteractiveReply(params.interactive, undefined, (_state, block) => {
    if (block.type === "text") {
      const text = block.text.trim();
      if (text) {
        body.push({
          type: "TextBlock",
          text,
          wrap: true,
        });
      }
      return undefined;
    }

    if (block.type === "buttons") {
      for (const button of block.buttons) {
        actions.push({
          type: "Action.Submit",
          title: button.label,
          data: {
            oc: "interactive",
            kind: "button",
            actionId: resolveInteractiveActionId(button),
            value: button.value,
            fallbackCommand: button.fallback?.command,
          },
        });
      }
      return undefined;
    }

    if (block.options.length > 0) {
      const inputId = `openclaw_interactive_select_${++selectIndex}`;
      body.push({
        type: "Input.ChoiceSet",
        id: inputId,
        placeholder: block.placeholder ?? "Choose an option",
        style: "compact",
        choices: block.options.map((option) => ({
          title: option.label,
          value: option.value,
        })),
      });
      actions.push({
        type: "Action.Submit",
        title: "Submit",
        data: {
          oc: "interactive",
          kind: "select",
          actionId: `select:${String(selectIndex)}`,
          inputId,
        },
      });
    }

    return undefined;
  });

  const fallbackText =
    resolveInteractiveTextFallback({
      text: params.text,
      interactive: params.interactive,
    }) ?? renderInteractiveCommandFallback(params.interactive);
  if (fallbackText && body.length === 0) {
    body.push({
      type: "TextBlock",
      text: fallbackText,
      wrap: true,
    });
  }
  const commandFallback = renderInteractiveCommandFallback(params.interactive);
  if (commandFallback && commandFallback !== fallbackText) {
    body.push({
      type: "TextBlock",
      text: commandFallback,
      wrap: true,
      isSubtle: true,
      spacing: "Medium",
    });
  }

  return {
    type: "AdaptiveCard",
    version: "1.5",
    body,
    ...(actions.length > 0 ? { actions } : {}),
  };
}

export const msteamsOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  pollMaxOptions: 12,
  sendPayload: async (ctx) => {
    if (ctx.payload.interactive && !ctx.payload.mediaUrl && !(ctx.payload.mediaUrls?.length ?? 0)) {
      return attachChannelToResult(
        "msteams",
        await sendAdaptiveCardMSTeams({
          cfg: ctx.cfg,
          to: ctx.to,
          card: buildMSTeamsInteractiveCard({
            interactive: ctx.payload.interactive,
            text: ctx.payload.text,
          }),
        }),
      );
    }
    const text =
      resolveInteractiveTextFallback({
        text: ctx.payload.text,
        interactive: ctx.payload.interactive,
      }) ?? "";
    if (ctx.payload.mediaUrl) {
      return await msteamsOutbound.sendMedia!({
        ...ctx,
        text,
        mediaUrl: ctx.payload.mediaUrl,
      });
    }
    return await msteamsOutbound.sendText!({
      ...ctx,
      text,
    });
  },
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
};
