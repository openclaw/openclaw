import { scot, da } from "@urbit/aura";
import {
  createMessageReceiptFromOutboundResults,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-outbound";
import type { UrbitSSEClient } from "./sse-client.js";
import { markdownToStory, createImageBlock, isImageUrl, type Story } from "./story.js";

type SendStoryParams = {
  api: { poke: (...args: Parameters<UrbitSSEClient["poke"]>) => Promise<unknown> };
  fromShip: string;
  toShip: string;
  story: Story;
  kind?: MessageReceiptPartKind;
};

function createTlonSendReceipt(params: {
  messageId: string;
  conversationId: string;
  kind: MessageReceiptPartKind;
}) {
  return createMessageReceiptFromOutboundResults({
    results: [
      {
        channel: "tlon",
        messageId: params.messageId,
        conversationId: params.conversationId,
      },
    ],
    threadId: params.conversationId,
    kind: params.kind,
  });
}

export async function sendDm({
  text,
  ...params
}: Omit<SendStoryParams, "story" | "kind"> & { text: string }) {
  return sendDmWithStory({ ...params, story: markdownToStory(text), kind: "text" });
}

export async function sendDmWithStory({
  api,
  fromShip,
  toShip,
  story,
  kind = "unknown",
}: SendStoryParams) {
  const sentAt = Date.now();
  const idUd = scot("ud", da.fromUnix(sentAt));
  const id = `${fromShip}/${idUd}`;

  const delta = {
    add: {
      memo: {
        content: story,
        author: fromShip,
        sent: sentAt,
      },
      kind: null,
      time: null,
    },
  };

  const action = {
    ship: toShip,
    diff: { id, delta },
  };

  await api.poke({
    app: "chat",
    mark: "chat-dm-action",
    json: action,
  });

  return {
    channel: "tlon",
    messageId: id,
    receipt: createTlonSendReceipt({ messageId: id, conversationId: toShip, kind }),
  };
}

type SendGroupStoryParams = Omit<SendStoryParams, "toShip"> & {
  hostShip: string;
  channelName: string;
  replyToId?: string | null;
};

export async function sendGroupMessage({
  text,
  ...params
}: Omit<SendGroupStoryParams, "story" | "kind"> & { text: string }) {
  return sendGroupMessageWithStory({ ...params, story: markdownToStory(text), kind: "text" });
}

export async function sendGroupMessageWithStory({
  api,
  fromShip,
  hostShip,
  channelName,
  story,
  replyToId,
  kind = "unknown",
}: SendGroupStoryParams) {
  const sentAt = Date.now();

  // Format reply ID as @ud (with dots) - required for Tlon to recognize thread replies
  let formattedReplyId = replyToId;
  if (replyToId && /^\d+$/.test(replyToId)) {
    try {
      formattedReplyId = scot("ud", BigInt(replyToId));
    } catch {
      // Fall back to raw ID if formatting fails
    }
  }

  const memo = { content: story, author: fromShip, sent: sentAt };
  const action = {
    channel: {
      nest: `chat/${hostShip}/${channelName}`,
      action: {
        post: formattedReplyId
          ? { reply: { id: formattedReplyId, action: { add: memo } } }
          : { add: { ...memo, kind: "/chat", blob: null, meta: null } },
      },
    },
  };

  await api.poke({
    app: "channels",
    mark: "channel-action-1",
    json: action,
  });

  const messageId = `${fromShip}/${sentAt}`;
  return {
    channel: "tlon",
    messageId,
    receipt: createTlonSendReceipt({
      messageId,
      conversationId: `${hostShip}/${channelName}`,
      kind,
    }),
  };
}

export function buildMediaStory(text: string | undefined, mediaUrl: string | undefined): Story {
  const story: Story = [];
  const cleanText = text?.trim() ?? "";
  const cleanUrl = mediaUrl?.trim() ?? "";

  if (cleanText) {
    story.push(...markdownToStory(cleanText));
  }

  if (cleanUrl && isImageUrl(cleanUrl)) {
    story.push(createImageBlock(cleanUrl, ""));
  } else if (cleanUrl) {
    story.push({ inline: [{ link: { href: cleanUrl, content: cleanUrl } }] });
  }

  return story.length > 0 ? story : [{ inline: [""] }];
}
