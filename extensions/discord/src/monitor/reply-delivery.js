import { resolveAgentAvatar } from "../../../../src/agents/identity-avatar.js";
import { createDiscordRetryRunner } from "../../../../src/infra/retry-policy.js";
import { resolveRetryConfig, retryAsync } from "../../../../src/infra/retry.js";
import { convertMarkdownTables } from "../../../../src/markdown/tables.js";
import { resolveDiscordAccount } from "../accounts.js";
import { chunkDiscordTextWithMode } from "../chunk.js";
import { sendMessageDiscord, sendVoiceMessageDiscord, sendWebhookMessageDiscord } from "../send.js";
import { sendDiscordText } from "../send.shared.js";
const DISCORD_DELIVERY_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 1e3,
  maxDelayMs: 3e4,
  jitter: 0
};
function isRetryableDiscordError(err) {
  const status = err.status ?? err.statusCode;
  return status === 429 || status !== void 0 && status >= 500;
}
function getDiscordRetryAfterMs(err) {
  if (!err || typeof err !== "object") {
    return void 0;
  }
  if ("retryAfter" in err && typeof err.retryAfter === "number" && Number.isFinite(err.retryAfter)) {
    return err.retryAfter * 1e3;
  }
  const retryAfterRaw = err.headers?.["retry-after"];
  if (!retryAfterRaw) {
    return void 0;
  }
  const retryAfterMs = Number(retryAfterRaw) * 1e3;
  return Number.isFinite(retryAfterMs) ? retryAfterMs : void 0;
}
function resolveDeliveryRetryConfig(retry) {
  return resolveRetryConfig(DISCORD_DELIVERY_RETRY_DEFAULTS, retry);
}
async function sendWithRetry(fn, retryConfig) {
  await retryAsync(fn, {
    ...retryConfig,
    shouldRetry: (err) => isRetryableDiscordError(err),
    retryAfterMs: getDiscordRetryAfterMs
  });
}
function resolveTargetChannelId(target) {
  if (!target.startsWith("channel:")) {
    return void 0;
  }
  const channelId = target.slice("channel:".length).trim();
  return channelId || void 0;
}
function resolveBoundThreadBinding(params) {
  const sessionKey = params.sessionKey?.trim();
  if (!params.threadBindings || !sessionKey) {
    return void 0;
  }
  const bindings = params.threadBindings.listBySessionKey(sessionKey);
  if (bindings.length === 0) {
    return void 0;
  }
  const targetChannelId = resolveTargetChannelId(params.target);
  if (!targetChannelId) {
    return void 0;
  }
  return bindings.find((entry) => entry.threadId === targetChannelId);
}
function resolveBindingPersona(cfg, binding) {
  if (!binding) {
    return {};
  }
  const baseLabel = binding.label?.trim() || binding.agentId;
  const username = (`\u{1F916} ${baseLabel}`.trim() || "\u{1F916} agent").slice(0, 80);
  let avatarUrl;
  try {
    const avatar = resolveAgentAvatar(cfg, binding.agentId);
    if (avatar.kind === "remote") {
      avatarUrl = avatar.url;
    }
  } catch {
    avatarUrl = void 0;
  }
  return { username, avatarUrl };
}
async function sendDiscordChunkWithFallback(params) {
  if (!params.text.trim()) {
    return;
  }
  const text = params.text;
  const binding = params.binding;
  if (binding?.webhookId && binding?.webhookToken) {
    try {
      await sendWebhookMessageDiscord(text, {
        cfg: params.cfg,
        webhookId: binding.webhookId,
        webhookToken: binding.webhookToken,
        accountId: binding.accountId,
        threadId: binding.threadId,
        replyTo: params.replyTo,
        username: params.username,
        avatarUrl: params.avatarUrl
      });
      return;
    } catch {
    }
  }
  if (params.channelId && params.request && params.rest) {
    const { channelId, request, rest } = params;
    await sendWithRetry(
      () => sendDiscordText(
        rest,
        channelId,
        text,
        params.replyTo,
        request,
        params.maxLinesPerMessage,
        void 0,
        void 0,
        params.chunkMode
      ),
      params.retryConfig
    );
    return;
  }
  await sendWithRetry(
    () => sendMessageDiscord(params.target, text, {
      cfg: params.cfg,
      token: params.token,
      rest: params.rest,
      accountId: params.accountId,
      replyTo: params.replyTo
    }),
    params.retryConfig
  );
}
async function sendAdditionalDiscordMedia(params) {
  for (const mediaUrl of params.mediaUrls) {
    const replyTo = params.resolveReplyTo();
    await sendWithRetry(
      () => sendMessageDiscord(params.target, "", {
        cfg: params.cfg,
        token: params.token,
        rest: params.rest,
        mediaUrl,
        accountId: params.accountId,
        mediaLocalRoots: params.mediaLocalRoots,
        replyTo
      }),
      params.retryConfig
    );
  }
}
async function deliverDiscordReply(params) {
  const chunkLimit = Math.min(params.textLimit, 2e3);
  const replyTo = params.replyToId?.trim() || void 0;
  const replyToMode = params.replyToMode ?? "all";
  const replyOnce = replyToMode === "first";
  let replyUsed = false;
  const resolveReplyTo = () => {
    if (!replyTo) {
      return void 0;
    }
    if (!replyOnce) {
      return replyTo;
    }
    if (replyUsed) {
      return void 0;
    }
    replyUsed = true;
    return replyTo;
  };
  const binding = resolveBoundThreadBinding({
    threadBindings: params.threadBindings,
    sessionKey: params.sessionKey,
    target: params.target
  });
  const persona = resolveBindingPersona(params.cfg, binding);
  const channelId = resolveTargetChannelId(params.target);
  const account = resolveDiscordAccount({ cfg: params.cfg, accountId: params.accountId });
  const retryConfig = resolveDeliveryRetryConfig(account.config.retry);
  const request = channelId ? createDiscordRetryRunner({ configRetry: account.config.retry }) : void 0;
  let deliveredAny = false;
  for (const payload of params.replies) {
    const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const rawText = payload.text ?? "";
    const tableMode = params.tableMode ?? "code";
    const text = convertMarkdownTables(rawText, tableMode);
    if (!text && mediaList.length === 0) {
      continue;
    }
    if (mediaList.length === 0) {
      const mode = params.chunkMode ?? "length";
      const chunks = chunkDiscordTextWithMode(text, {
        maxChars: chunkLimit,
        maxLines: params.maxLinesPerMessage,
        chunkMode: mode
      });
      if (!chunks.length && text) {
        chunks.push(text);
      }
      for (const chunk of chunks) {
        if (!chunk.trim()) {
          continue;
        }
        const replyTo3 = resolveReplyTo();
        await sendDiscordChunkWithFallback({
          cfg: params.cfg,
          target: params.target,
          text: chunk,
          token: params.token,
          rest: params.rest,
          accountId: params.accountId,
          maxLinesPerMessage: params.maxLinesPerMessage,
          replyTo: replyTo3,
          binding,
          chunkMode: params.chunkMode,
          username: persona.username,
          avatarUrl: persona.avatarUrl,
          channelId,
          request,
          retryConfig
        });
        deliveredAny = true;
      }
      continue;
    }
    const firstMedia = mediaList[0];
    if (!firstMedia) {
      continue;
    }
    const sendRemainingMedia = () => sendAdditionalDiscordMedia({
      cfg: params.cfg,
      target: params.target,
      token: params.token,
      rest: params.rest,
      accountId: params.accountId,
      mediaUrls: mediaList.slice(1),
      mediaLocalRoots: params.mediaLocalRoots,
      resolveReplyTo,
      retryConfig
    });
    if (payload.audioAsVoice) {
      const replyTo3 = resolveReplyTo();
      await sendVoiceMessageDiscord(params.target, firstMedia, {
        cfg: params.cfg,
        token: params.token,
        rest: params.rest,
        accountId: params.accountId,
        replyTo: replyTo3
      });
      deliveredAny = true;
      await sendDiscordChunkWithFallback({
        cfg: params.cfg,
        target: params.target,
        text,
        token: params.token,
        rest: params.rest,
        accountId: params.accountId,
        maxLinesPerMessage: params.maxLinesPerMessage,
        replyTo: resolveReplyTo(),
        binding,
        chunkMode: params.chunkMode,
        username: persona.username,
        avatarUrl: persona.avatarUrl,
        channelId,
        request,
        retryConfig
      });
      await sendRemainingMedia();
      continue;
    }
    const replyTo2 = resolveReplyTo();
    await sendMessageDiscord(params.target, text, {
      cfg: params.cfg,
      token: params.token,
      rest: params.rest,
      mediaUrl: firstMedia,
      accountId: params.accountId,
      mediaLocalRoots: params.mediaLocalRoots,
      replyTo: replyTo2
    });
    deliveredAny = true;
    await sendRemainingMedia();
  }
  if (binding && deliveredAny) {
    params.threadBindings?.touchThread?.({ threadId: binding.threadId });
  }
}
export {
  deliverDiscordReply
};
