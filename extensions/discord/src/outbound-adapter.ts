import {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequenceOrFallback,
  sendTextMediaPayload,
} from "openclaw/plugin-sdk/channel-runtime";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-runtime";
import { resolveOutboundSendDep } from "openclaw/plugin-sdk/channel-runtime";
import {
  attachChannelToResult,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { OutboundIdentity } from "openclaw/plugin-sdk/infra-runtime";
import type { DiscordComponentMessageSpec } from "./components.js";
import { getThreadBindingManager, type ThreadBindingRecord } from "./monitor/thread-bindings.js";
import { normalizeDiscordOutboundTarget } from "./normalize.js";
import {
  sendDiscordComponentMessage,
  sendMessageDiscord,
  sendPollDiscord,
  sendWebhookMessageDiscord,
} from "./send.js";
import { buildDiscordInteractiveComponents } from "./shared-interactive.js";

export const DISCORD_TEXT_CHUNK_LIMIT = 2000;

// ---------------------------------------------------------------------------
// Adaptive Card rendering: inline card extraction + Discord embed conversion.
// Mirrors src/cards/parse.ts + src/cards/strategies/discord.ts but kept inline
// to avoid cross-workspace imports (extensions cannot import from src/ directly).
// ---------------------------------------------------------------------------

const AC_CARD_RE = /<!--adaptive-card-->([\s\S]*?)<!--\/adaptive-card-->/;
const AC_MARKERS_RE =
  /<!--adaptive-card-->[\s\S]*?<!--\/adaptive-card-->|<!--adaptive-card-data-->[\s\S]*?<!--\/adaptive-card-data-->/g;

/** Strip all adaptive card markers, returning only the fallback text. */
function stripCardMarkers(text: string): string {
  return text.replace(AC_MARKERS_RE, "").trim();
}

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

interface DiscordEmbed {
  title?: string;
  description?: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  image?: { url: string };
}

function buildEmbedFromBody(body: unknown[]): DiscordEmbed {
  const embed: DiscordEmbed = {};
  const descParts: string[] = [];
  for (const raw of body) {
    const el = raw as AcElement;
    switch (el.type) {
      case "TextBlock": {
        const text = acStr(el.text);
        const weight = el.weight as string | undefined;
        if (weight === "Bolder" && !embed.title) {
          embed.title = text;
        } else {
          descParts.push(weight === "Bolder" ? `**${text}**` : text);
        }
        break;
      }
      case "FactSet": {
        const facts = el.facts as Array<{ title?: string; value?: string }> | undefined;
        if (facts?.length) {
          embed.fields ??= [];
          for (const f of facts) {
            embed.fields.push({ name: f.title ?? "", value: f.value ?? "", inline: true });
          }
        }
        break;
      }
      case "Image": {
        const url = acStr(el.url);
        if (url) embed.image = { url };
        break;
      }
      case "ColumnSet": {
        const columns = el.columns as Array<{ items?: AcElement[] }> | undefined;
        if (columns?.length) {
          const sub = buildEmbedFromBody(columns.flatMap((col) => col.items ?? []));
          if (sub.title && !embed.title) embed.title = sub.title;
          if (sub.description) descParts.push(sub.description);
          if (sub.fields?.length) { embed.fields ??= []; embed.fields.push(...sub.fields); }
          if (sub.image && !embed.image) embed.image = sub.image;
        }
        break;
      }
      case "Container": {
        const items = el.items as AcElement[] | undefined;
        if (items?.length) {
          const sub = buildEmbedFromBody(items);
          if (sub.title && !embed.title) embed.title = sub.title;
          if (sub.description) descParts.push(sub.description);
          if (sub.fields?.length) { embed.fields ??= []; embed.fields.push(...sub.fields); }
          if (sub.image && !embed.image) embed.image = sub.image;
        }
        break;
      }
    }
  }
  if (descParts.length > 0) embed.description = descParts.join("\n");
  return embed;
}

function buildActionRow(actions: unknown[]): unknown | null {
  const buttons: Array<{ type: 2; style: number; label: string; url?: string; custom_id?: string }> = [];
  for (const raw of actions) {
    const action = raw as AcElement;
    const label = acStr(action.title);
    if (!label) continue;
    if (action.type === "Action.OpenUrl") {
      const url = acStr(action.url);
      if (!url) continue; // skip: Discord rejects link buttons with an empty URL
      buttons.push({ type: 2, style: 5, label, url });
    } else if (action.type === "Action.Submit") {
      const customId = typeof action.id === "string" ? action.id : `ac_submit_${buttons.length}`;
      buttons.push({ type: 2, style: 1, label, custom_id: customId });
    }
  }
  return buttons.length > 0 ? { type: 1, components: buttons } : null;
}

function renderDiscordCard(parsed: AcParsed): {
  embeds: DiscordEmbed[];
  components: unknown[] | undefined;
  fallback: string;
} {
  const embed = buildEmbedFromBody(parsed.card.body);
  const components: unknown[] = [];
  if (parsed.card.actions?.length) {
    const row = buildActionRow(parsed.card.actions);
    if (row) components.push(row);
  }
  return {
    embeds: [embed],
    components: components.length > 0 ? components : undefined,
    fallback: parsed.fallbackText,
  };
}

function resolveDiscordOutboundTarget(params: {
  to: string;
  threadId?: string | number | null;
}): string {
  if (params.threadId == null) {
    return params.to;
  }
  const threadId = String(params.threadId).trim();
  if (!threadId) {
    return params.to;
  }
  return `channel:${threadId}`;
}

function resolveDiscordWebhookIdentity(params: {
  identity?: OutboundIdentity;
  binding: ThreadBindingRecord;
}): { username?: string; avatarUrl?: string } {
  const usernameRaw = params.identity?.name?.trim();
  const fallbackUsername = params.binding.label?.trim() || params.binding.agentId;
  const username = (usernameRaw || fallbackUsername || "").slice(0, 80) || undefined;
  const avatarUrl = params.identity?.avatarUrl?.trim() || undefined;
  return { username, avatarUrl };
}

async function maybeSendDiscordWebhookText(params: {
  cfg?: OpenClawConfig;
  text: string;
  threadId?: string | number | null;
  accountId?: string | null;
  identity?: OutboundIdentity;
  replyToId?: string | null;
}): Promise<{ messageId: string; channelId: string } | null> {
  if (params.threadId == null) {
    return null;
  }
  const threadId = String(params.threadId).trim();
  if (!threadId) {
    return null;
  }
  const manager = getThreadBindingManager(params.accountId ?? undefined);
  if (!manager) {
    return null;
  }
  const binding = manager.getByThreadId(threadId);
  if (!binding?.webhookId || !binding?.webhookToken) {
    return null;
  }
  const persona = resolveDiscordWebhookIdentity({
    identity: params.identity,
    binding,
  });
  const result = await sendWebhookMessageDiscord(params.text, {
    webhookId: binding.webhookId,
    webhookToken: binding.webhookToken,
    accountId: binding.accountId,
    threadId: binding.threadId,
    cfg: params.cfg,
    replyTo: params.replyToId ?? undefined,
    username: persona.username,
    avatarUrl: persona.avatarUrl,
  });
  return result;
}

export const discordOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: DISCORD_TEXT_CHUNK_LIMIT,
  pollMaxOptions: 10,
  resolveTarget: ({ to }) => normalizeDiscordOutboundTarget(to),
  sendPayload: async (ctx) => {
    const payload = {
      ...ctx.payload,
      text: ctx.payload.text ?? "",
    };
    const discordData = payload.channelData?.discord as
      | { components?: DiscordComponentMessageSpec }
      | undefined;
    const rawComponentSpec =
      discordData?.components ?? buildDiscordInteractiveComponents(payload.interactive);
    const componentSpec = rawComponentSpec
      ? rawComponentSpec.text
        ? rawComponentSpec
        : {
            ...rawComponentSpec,
            text: payload.text?.trim() ? payload.text : undefined,
          }
      : undefined;
    if (!componentSpec) {
      return await sendTextMediaPayload({
        channel: "discord",
        ctx: {
          ...ctx,
          payload,
        },
        adapter: discordOutbound,
      });
    }
    const send =
      resolveOutboundSendDep<typeof sendMessageDiscord>(ctx.deps, "discord") ?? sendMessageDiscord;
    const target = resolveDiscordOutboundTarget({ to: ctx.to, threadId: ctx.threadId });
    const mediaUrls = resolvePayloadMediaUrls(payload);
    const result = await sendPayloadMediaSequenceOrFallback({
      text: payload.text ?? "",
      mediaUrls,
      fallbackResult: { messageId: "", channelId: target },
      sendNoMedia: async () =>
        await sendDiscordComponentMessage(target, componentSpec, {
          replyTo: ctx.replyToId ?? undefined,
          accountId: ctx.accountId ?? undefined,
          silent: ctx.silent ?? undefined,
          cfg: ctx.cfg,
        }),
      send: async ({ text, mediaUrl, isFirst }) => {
        if (isFirst) {
          return await sendDiscordComponentMessage(target, componentSpec, {
            mediaUrl,
            mediaLocalRoots: ctx.mediaLocalRoots,
            replyTo: ctx.replyToId ?? undefined,
            accountId: ctx.accountId ?? undefined,
            silent: ctx.silent ?? undefined,
            cfg: ctx.cfg,
          });
        }
        return await send(target, text, {
          verbose: false,
          mediaUrl,
          mediaLocalRoots: ctx.mediaLocalRoots,
          replyTo: ctx.replyToId ?? undefined,
          accountId: ctx.accountId ?? undefined,
          silent: ctx.silent ?? undefined,
          cfg: ctx.cfg,
        });
      },
    });
    return attachChannelToResult("discord", result);
  },
  ...createAttachedChannelResultAdapter({
    channel: "discord",
    sendText: async ({ cfg, to, text, accountId, deps, replyToId, threadId, identity, silent }) => {
      // Adaptive card rendering: convert card markers to Discord embeds + components
      const parsed = parseAdaptiveCardMarkers(text);
      if (parsed) {
        const rendered = renderDiscordCard(parsed);
        if (rendered.embeds.length > 0) {
          const send =
            resolveOutboundSendDep<typeof sendMessageDiscord>(deps, "discord") ?? sendMessageDiscord;
          const target = resolveDiscordOutboundTarget({ to, threadId });
          return await send(target, rendered.fallback, {
            verbose: false,
            replyTo: replyToId ?? undefined,
            accountId: accountId ?? undefined,
            silent: silent ?? undefined,
            cfg,
            embeds: rendered.embeds as NonNullable<
              Parameters<typeof sendMessageDiscord>[2]
            >["embeds"],
            components: rendered.components as NonNullable<
              Parameters<typeof sendMessageDiscord>[2]
            >["components"],
          });
        }
        // Card markers present but rendering failed; strip markers to avoid leaking raw JSON
        text = parsed.fallbackText || stripCardMarkers(text);
      }

      if (!silent) {
        const webhookResult = await maybeSendDiscordWebhookText({
          cfg,
          text,
          threadId,
          accountId,
          identity,
          replyToId,
        }).catch(() => null);
        if (webhookResult) {
          return webhookResult;
        }
      }
      const send =
        resolveOutboundSendDep<typeof sendMessageDiscord>(deps, "discord") ?? sendMessageDiscord;
      return await send(resolveDiscordOutboundTarget({ to, threadId }), text, {
        verbose: false,
        replyTo: replyToId ?? undefined,
        accountId: accountId ?? undefined,
        silent: silent ?? undefined,
        cfg,
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
      silent,
    }) => {
      const send =
        resolveOutboundSendDep<typeof sendMessageDiscord>(deps, "discord") ?? sendMessageDiscord;
      return await send(resolveDiscordOutboundTarget({ to, threadId }), text, {
        verbose: false,
        mediaUrl,
        mediaLocalRoots,
        replyTo: replyToId ?? undefined,
        accountId: accountId ?? undefined,
        silent: silent ?? undefined,
        cfg,
      });
    },
    sendPoll: async ({ cfg, to, poll, accountId, threadId, silent }) =>
      await sendPollDiscord(resolveDiscordOutboundTarget({ to, threadId }), poll, {
        accountId: accountId ?? undefined,
        silent: silent ?? undefined,
        cfg,
      }),
  }),
};
