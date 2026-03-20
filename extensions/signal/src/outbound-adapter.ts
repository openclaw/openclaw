import type { ChannelOutboundAdapter, OutboundSendDeps } from "openclaw/plugin-sdk/channel-runtime";
import {
  createDirectTextMediaOutbound,
  createScopedChannelMediaMaxBytesResolver,
  resolveOutboundSendDep,
} from "openclaw/plugin-sdk/channel-runtime";
import {
  attachChannelToResult,
  attachChannelToResults,
} from "openclaw/plugin-sdk/channel-send-result";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/config-runtime";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-runtime";
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

const signalBase = createDirectTextMediaOutbound({
  channel: "signal",
  resolveSender: resolveSignalSender,
  resolveMaxBytes: resolveSignalMaxBytes,
  chunker: (text: string, _limit: number) =>
    text.split(/\n{2,}/).flatMap((chunk) => (chunk ? [chunk] : [])),
  buildTextOptions: ({ cfg, maxBytes, accountId }) => ({
    cfg,
    maxBytes,
    accountId: accountId ?? undefined,
  }),
  buildMediaOptions: ({ cfg, mediaUrl, maxBytes, accountId, mediaLocalRoots }) => ({
    cfg,
    mediaUrl,
    maxBytes,
    accountId: accountId ?? undefined,
    mediaLocalRoots,
  }),
});

export const signalOutbound: ChannelOutboundAdapter = {
  ...signalBase,
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
      results.push(result);
    }
    return attachChannelToResults("signal", results);
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
    return attachChannelToResult("signal", result);
  },
};
