import { resolveOutboundSendDep } from "openclaw/plugin-sdk/compat";
import {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequence,
  sendTextMediaPayload,
} from "../../../src/channels/plugins/outbound/direct-text-media.js";
import type { ChannelOutboundAdapter } from "../../../src/channels/plugins/types.js";
import type { OutboundIdentity } from "../../../src/infra/outbound/identity.js";
import {
  resolveInteractiveTextFallback,
  type InteractiveReply,
} from "../../../src/interactive/payload.js";
import { getGlobalHookRunner } from "../../../src/plugins/hook-runner-global.js";
import { parseSlackBlocksInput } from "./blocks-input.js";
import { buildSlackInteractiveBlocks, type SlackBlock } from "./blocks-render.js";
import { sendMessageSlack, type SlackSendIdentity } from "./send.js";

const SLACK_MAX_BLOCKS = 50;

function resolveRenderedInteractiveBlocks(
  interactive?: InteractiveReply,
): SlackBlock[] | undefined {
  if (!interactive) {
    return undefined;
  }
  const blocks = buildSlackInteractiveBlocks(interactive);
  return blocks.length > 0 ? blocks : undefined;
}

function resolveSlackSendIdentity(identity?: OutboundIdentity): SlackSendIdentity | undefined {
  if (!identity) {
    return undefined;
  }
  const username = identity.name?.trim() || undefined;
  const iconUrl = identity.avatarUrl?.trim() || undefined;
  const rawEmoji = identity.emoji?.trim();
  const iconEmoji = !iconUrl && rawEmoji && /^:[^:\s]+:$/.test(rawEmoji) ? rawEmoji : undefined;
  if (!username && !iconUrl && !iconEmoji) {
    return undefined;
  }
  return { username, iconUrl, iconEmoji };
}

async function applySlackMessageSendingHooks(params: {
  to: string;
  text: string;
  threadTs?: string;
  accountId?: string;
  mediaUrl?: string;
}): Promise<{ cancelled: boolean; text: string }> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("message_sending")) {
    return { cancelled: false, text: params.text };
  }
  const hookResult = await hookRunner.runMessageSending(
    {
      to: params.to,
      content: params.text,
      metadata: {
        threadTs: params.threadTs,
        channelId: params.to,
        ...(params.mediaUrl ? { mediaUrl: params.mediaUrl } : {}),
      },
    },
    { channelId: "slack", accountId: params.accountId ?? undefined },
  );
  if (hookResult?.cancel) {
    return { cancelled: true, text: params.text };
  }
  return { cancelled: false, text: hookResult?.content ?? params.text };
}

async function sendSlackOutboundMessage(params: {
  cfg: NonNullable<Parameters<typeof sendMessageSlack>[2]>["cfg"];
  to: string;
  text: string;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  blocks?: NonNullable<Parameters<typeof sendMessageSlack>[2]>["blocks"];
  accountId?: string | null;
  deps?: { [channelId: string]: unknown } | null;
  replyToId?: string | null;
  threadId?: string | number | null;
  identity?: OutboundIdentity;
}) {
  const send =
    resolveOutboundSendDep<typeof sendMessageSlack>(params.deps, "slack") ?? sendMessageSlack;
  const threadTs =
    params.replyToId ?? (params.threadId != null ? String(params.threadId) : undefined);
  const hookResult = await applySlackMessageSendingHooks({
    to: params.to,
    text: params.text,
    threadTs,
    mediaUrl: params.mediaUrl,
    accountId: params.accountId ?? undefined,
  });
  if (hookResult.cancelled) {
    return {
      channel: "slack" as const,
      messageId: "cancelled-by-hook",
      channelId: params.to,
      meta: { cancelled: true },
    };
  }

  const slackIdentity = resolveSlackSendIdentity(params.identity);
  const result = await send(params.to, hookResult.text, {
    cfg: params.cfg,
    threadTs,
    accountId: params.accountId ?? undefined,
    ...(params.mediaUrl
      ? { mediaUrl: params.mediaUrl, mediaLocalRoots: params.mediaLocalRoots }
      : {}),
    ...(params.blocks ? { blocks: params.blocks } : {}),
    ...(slackIdentity ? { identity: slackIdentity } : {}),
  });
  return { channel: "slack" as const, ...result };
}

function resolveSlackBlocks(payload: {
  channelData?: Record<string, unknown>;
  interactive?: InteractiveReply;
}) {
  const slackData = payload.channelData?.slack;
  const renderedInteractive = resolveRenderedInteractiveBlocks(payload.interactive);
  if (!slackData || typeof slackData !== "object" || Array.isArray(slackData)) {
    return renderedInteractive;
  }
  const existingBlocks = parseSlackBlocksInput((slackData as { blocks?: unknown }).blocks) as
    | SlackBlock[]
    | undefined;
  const mergedBlocks = [...(existingBlocks ?? []), ...(renderedInteractive ?? [])];
  if (mergedBlocks.length === 0) {
    return undefined;
  }
  if (mergedBlocks.length > SLACK_MAX_BLOCKS) {
    throw new Error(
      `Slack blocks cannot exceed ${SLACK_MAX_BLOCKS} items after interactive render`,
    );
  }
  return mergedBlocks;
}

export const slackOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: 4000,
  sendPayload: async (ctx) => {
    const payload = {
      ...ctx.payload,
      text:
        resolveInteractiveTextFallback({
          text: ctx.payload.text,
          interactive: ctx.payload.interactive,
        }) ?? "",
    };
    const blocks = resolveSlackBlocks(payload);
    if (!blocks) {
      return await sendTextMediaPayload({
        channel: "slack",
        ctx: {
          ...ctx,
          payload,
        },
        adapter: slackOutbound,
      });
    }
    const mediaUrls = resolvePayloadMediaUrls(payload);
    if (mediaUrls.length === 0) {
      return await sendSlackOutboundMessage({
        cfg: ctx.cfg,
        to: ctx.to,
        text: payload.text ?? "",
        mediaLocalRoots: ctx.mediaLocalRoots,
        blocks,
        accountId: ctx.accountId,
        deps: ctx.deps,
        replyToId: ctx.replyToId,
        threadId: ctx.threadId,
        identity: ctx.identity,
      });
    }
    await sendPayloadMediaSequence({
      text: "",
      mediaUrls,
      send: async ({ text, mediaUrl }) =>
        await sendSlackOutboundMessage({
          cfg: ctx.cfg,
          to: ctx.to,
          text,
          mediaUrl,
          mediaLocalRoots: ctx.mediaLocalRoots,
          accountId: ctx.accountId,
          deps: ctx.deps,
          replyToId: ctx.replyToId,
          threadId: ctx.threadId,
          identity: ctx.identity,
        }),
    });
    return await sendSlackOutboundMessage({
      cfg: ctx.cfg,
      to: ctx.to,
      text: payload.text ?? "",
      mediaLocalRoots: ctx.mediaLocalRoots,
      blocks,
      accountId: ctx.accountId,
      deps: ctx.deps,
      replyToId: ctx.replyToId,
      threadId: ctx.threadId,
      identity: ctx.identity,
    });
  },
  sendText: async ({ cfg, to, text, accountId, deps, replyToId, threadId, identity }) => {
    return await sendSlackOutboundMessage({
      cfg,
      to,
      text,
      accountId,
      deps,
      replyToId,
      threadId,
      identity,
    });
  },
  sendMedia: async ({
    cfg,
    to,
    text,
    mediaUrl,
    mediaLocalRoots,
    accountId,
    deps,
    replyToId,
    threadId,
    identity,
  }) => {
    return await sendSlackOutboundMessage({
      cfg,
      to,
      text,
      mediaUrl,
      mediaLocalRoots,
      accountId,
      deps,
      replyToId,
      threadId,
      identity,
    });
  },
};
