import {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequenceAndFinalize,
  sendTextMediaPayload,
} from "openclaw/plugin-sdk/channel-runtime";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-runtime";
import { resolveOutboundSendDep } from "openclaw/plugin-sdk/channel-runtime";
import {
  attachChannelToResult,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import type { OutboundIdentity } from "openclaw/plugin-sdk/infra-runtime";
import {
  resolveInteractiveTextFallback,
  type InteractiveReply,
} from "openclaw/plugin-sdk/interactive-runtime";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import { parseSlackBlocksInput } from "./blocks-input.js";
import { buildSlackInteractiveBlocks, type SlackBlock } from "./blocks-render.js";
import { sendMessageSlack, type SlackSendIdentity } from "./send.js";

const SLACK_MAX_BLOCKS = 50;

// ---------------------------------------------------------------------------
// Adaptive Card rendering: inline card extraction + Slack Block Kit conversion.
// Mirrors src/cards/parse.ts + src/cards/strategies/slack.ts but kept inline
// to avoid cross-workspace imports (extensions cannot import from src/ directly).
// ---------------------------------------------------------------------------

const AC_CARD_RE = /<!--adaptive-card-->([\s\S]*?)<!--\/adaptive-card-->/;

interface AcParsed {
  card: { type: "AdaptiveCard"; body: unknown[]; actions?: unknown[] };
  fallbackText: string;
}

function parseAdaptiveCardMarkers(text: string): AcParsed | null {
  const m = AC_CARD_RE.exec(text);
  if (!m) {
    return null;
  }
  try {
    const card = JSON.parse(m[1].trim());
    if (card?.type !== "AdaptiveCard") {
      return null;
    }
    const fallbackText = text.slice(0, m.index).trim();
    return { card, fallbackText };
  } catch {
    return null;
  }
}

type AcElement = Record<string, unknown>;

function acStr(val: unknown, fallback = ""): string {
  if (typeof val === "string") return val;
  if (val == null) return fallback;
  return JSON.stringify(val);
}

function renderAcTextBlock(el: AcElement): unknown {
  const text = acStr(el.text);
  const weight = el.weight as string | undefined;
  const formatted = weight === "Bolder" ? `*${text}*` : text;
  return { type: "section", text: { type: "mrkdwn", text: formatted } };
}

function renderAcFactSet(el: AcElement): unknown | null {
  const facts = el.facts as Array<{ title?: string; value?: string }> | undefined;
  if (!facts?.length) return null;
  return {
    type: "section",
    fields: facts.map((f) => ({ type: "mrkdwn", text: `*${f.title ?? ""}*\n${f.value ?? ""}` })),
  };
}

function renderAcImage(el: AcElement): unknown | null {
  const url = acStr(el.url);
  const alt = acStr(el.altText) || acStr(el.alt) || "image";
  if (!url) return null;
  return { type: "image", image_url: url, alt_text: alt };
}

function renderAcElement(el: AcElement): unknown[] {
  switch (el.type) {
    case "TextBlock":
      return [renderAcTextBlock(el)];
    case "FactSet": {
      const block = renderAcFactSet(el);
      return block ? [block] : [];
    }
    case "Image": {
      const block = renderAcImage(el);
      return block ? [block] : [];
    }
    case "ColumnSet": {
      const columns = el.columns as Array<{ items?: AcElement[] }> | undefined;
      if (!columns?.length) return [];
      return columns.flatMap((col) => (col.items ?? []).flatMap(renderAcElement));
    }
    case "Container": {
      const items = el.items as AcElement[] | undefined;
      return (items ?? []).flatMap(renderAcElement);
    }
    default:
      return [];
  }
}

function renderAcActions(actions: unknown[]): unknown[] {
  type SlackButton = {
    type: "button";
    text: { type: "plain_text"; text: string };
    url?: string;
    action_id?: string;
    value?: string;
  };
  const buttons: SlackButton[] = [];
  for (const raw of actions) {
    const action = raw as AcElement;
    const label = acStr(action.title);
    if (!label) continue;
    if (action.type === "Action.OpenUrl") {
      buttons.push({ type: "button", text: { type: "plain_text", text: label }, url: acStr(action.url) });
    } else if (action.type === "Action.Submit") {
      const actionId = typeof action.id === "string" ? action.id : `ac_submit_${buttons.length}`;
      buttons.push({
        type: "button",
        text: { type: "plain_text", text: label },
        action_id: actionId,
        value: action.data != null ? JSON.stringify(action.data) : undefined,
      });
    }
  }
  return buttons.length > 0 ? [{ type: "actions", elements: buttons }] : [];
}

function renderSlackCard(parsed: AcParsed): { blocks: unknown[]; fallback: string } {
  const blocks: unknown[] = [];
  for (const el of parsed.card.body) {
    const rendered = renderAcElement(el as AcElement);
    if (rendered.length > 0) {
      if (blocks.length > 0) blocks.push({ type: "divider" });
      blocks.push(...rendered);
    }
  }
  if (parsed.card.actions?.length) {
    blocks.push(...renderAcActions(parsed.card.actions));
  }
  return { blocks, fallback: parsed.fallbackText };
}

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
  return result;
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
    return attachChannelToResult(
      "slack",
      await sendPayloadMediaSequenceAndFinalize({
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
        finalize: async () =>
          await sendSlackOutboundMessage({
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
          }),
      }),
    );
  },
  ...createAttachedChannelResultAdapter({
    channel: "slack",
    sendText: async ({ cfg, to, text, accountId, deps, replyToId, threadId, identity }) => {
      // Adaptive card rendering: convert card markers to Slack Block Kit
      const acParsed = parseAdaptiveCardMarkers(text);
      if (acParsed) {
        const rendered = renderSlackCard(acParsed);
        if (rendered.blocks.length > 0) {
          const send =
            resolveOutboundSendDep<typeof sendMessageSlack>(deps, "slack") ?? sendMessageSlack;
          const threadTs = replyToId ?? (threadId != null ? String(threadId) : undefined);
          const slackIdentity = resolveSlackSendIdentity(identity);
          return await send(to, rendered.fallback, {
            cfg,
            threadTs,
            accountId: accountId ?? undefined,
            blocks: rendered.blocks as NonNullable<Parameters<typeof sendMessageSlack>[2]>["blocks"],
            ...(slackIdentity ? { identity: slackIdentity } : {}),
          });
        }
      }

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
    }) =>
      await sendSlackOutboundMessage({
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
      }),
  }),
};
