import { resolveOutboundSendDep, type OutboundSendDeps } from "openclaw/plugin-sdk/compat";
import { resolveTextChunkLimit } from "../../../src/auto-reply/chunk.js";
import { createScopedChannelMediaMaxBytesResolver } from "../../../src/channels/plugins/outbound/direct-text-media.js";
import type { ChannelOutboundAdapter } from "../../../src/channels/plugins/types.js";
import { resolveMarkdownTableMode } from "../../../src/config/markdown-tables.js";
import { markdownToSignalTextChunks } from "./format.js";
import { sendMessageSignal } from "./send.js";

function resolveSignalSender(deps: OutboundSendDeps | undefined) {
  return resolveOutboundSendDep<typeof sendMessageSignal>(deps, "signal") ?? sendMessageSignal;
}

const resolveSignalMaxBytes = createScopedChannelMediaMaxBytesResolver("signal");
type SignalSendOpts = NonNullable<Parameters<typeof sendMessageSignal>[2]>;

function inferSignalTableMode(params: { cfg: SignalSendOpts["cfg"]; accountId?: string | null }) {
  return resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "signal",
    accountId: params.accountId ?? undefined,
  });
}

export const signalOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, _limit) => text.split(/\n{2,}/).flatMap((chunk) => (chunk ? [chunk] : [])),
  chunkerMode: "text",
  textChunkLimit: 4000,
  sendFormattedText: async ({ cfg, to, text, accountId, deps, abortSignal }) => {
    const send = resolveSignalSender(deps);
    const maxBytes = resolveSignalMaxBytes({
      cfg,
      accountId: accountId ?? undefined,
    });
    const limit = resolveTextChunkLimit(cfg, "signal", accountId ?? undefined, {
      fallbackLimit: 4000,
    });
    const tableMode = inferSignalTableMode({ cfg, accountId });
    let chunks =
      limit === undefined
        ? markdownToSignalTextChunks(text, Number.POSITIVE_INFINITY, { tableMode })
        : markdownToSignalTextChunks(text, limit, { tableMode });
    if (chunks.length === 0 && text) {
      chunks = [{ text, styles: [] }];
    }
    const results = [];
    for (const chunk of chunks) {
      abortSignal?.throwIfAborted();
      const result = await send(to, chunk.text, {
        cfg,
        maxBytes,
        accountId: accountId ?? undefined,
        textMode: "plain",
        textStyles: chunk.styles,
      });
      results.push({ channel: "signal" as const, ...result });
    }
    return results;
  },
  sendFormattedMedia: async ({
    cfg,
    to,
    text,
    mediaUrl,
    mediaLocalRoots,
    accountId,
    deps,
    abortSignal,
  }) => {
    abortSignal?.throwIfAborted();
    const send = resolveSignalSender(deps);
    const maxBytes = resolveSignalMaxBytes({
      cfg,
      accountId: accountId ?? undefined,
    });
    const tableMode = inferSignalTableMode({ cfg, accountId });
    const formatted = markdownToSignalTextChunks(text, Number.POSITIVE_INFINITY, {
      tableMode,
    })[0] ?? {
      text,
      styles: [],
    };
    const result = await send(to, formatted.text, {
      cfg,
      mediaUrl,
      maxBytes,
      accountId: accountId ?? undefined,
      textMode: "plain",
      textStyles: formatted.styles,
      mediaLocalRoots,
    });
    return { channel: "signal", ...result };
  },
  sendText: async ({ cfg, to, text, accountId, deps }) => {
    const send = resolveSignalSender(deps);
    const maxBytes = resolveSignalMaxBytes({
      cfg,
      accountId: accountId ?? undefined,
    });
    const result = await send(to, text, {
      cfg,
      maxBytes,
      accountId: accountId ?? undefined,
    });
    return { channel: "signal", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId, deps }) => {
    const send = resolveSignalSender(deps);
    const maxBytes = resolveSignalMaxBytes({
      cfg,
      accountId: accountId ?? undefined,
    });
    const result = await send(to, text, {
      cfg,
      mediaUrl,
      maxBytes,
      accountId: accountId ?? undefined,
      mediaLocalRoots,
    });
    return { channel: "signal", ...result };
  },
};
