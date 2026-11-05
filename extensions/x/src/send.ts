import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import {
  loadOutboundMediaFromUrl,
  type OutboundMediaLoadOptions,
} from "openclaw/plugin-sdk/outbound-media";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveXAccount } from "./accounts.js";
import { XAllowlistChangedError } from "./allowlist.js";
import type { XApiClient, XPost } from "./api.js";
import { getXApi } from "./client.js";
import type { XSenderTier } from "./guest-policy.js";
import { resolveXIngress } from "./ingress.js";
import type { XMediaUploadParams } from "./media-api.js";
import { resolveXRecipient } from "./recipient.js";
import { getXRuntime } from "./runtime.js";
import { XBudgetExceededError } from "./spend.js";
import { normalizeXReplyTarget } from "./target.js";
import { findXUrls } from "./urls.js";
import { resolveXWorkOrigin } from "./work-origin.js";

const DEFAULT_X_REPLY_SIGNATURE = "🤖 automated reply";
type XMedia = Pick<XMediaUploadParams, "buffer" | "contentType" | "fileName" | "mediaCategory">;
// Keep buffered uploads bounded on the Gateway, independently of X's larger account limits.
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export type XVisibleWorkSession = Parameters<
  NonNullable<GetReplyOptions["onVisibleWorkSessions"]>
>[0][number];
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
const emojiSequence = new RegExp("^\\p{RGI_Emoji}$", "v");

function characterWeight(value: string): number {
  // Arbitrary ZWJ runs are graphemes too, but only standardized emoji collapse to weight two.
  if (emojiSequence.test(value) || /^\p{Extended_Pictographic}$/u.test(value)) {
    return 2;
  }
  return Array.from(value).reduce((total, char) => {
    const code = char.codePointAt(0)!;
    return (
      total +
      (code <= 0x10ff ||
      (code >= 0x2000 && code <= 0x200d) ||
      (code >= 0x2010 && code <= 0x201f) ||
      (code >= 0x2032 && code <= 0x2037)
        ? 1
        : 2)
    );
  }, 0);
}

function weightedTokens(text: string): { text: string; weight: number }[] {
  const tokens: { text: string; weight: number }[] = [];
  let offset = 0;
  const appendText = (value: string) => {
    tokens.push(
      ...Array.from(graphemes.segment(value), ({ segment }) => ({
        text: segment,
        weight: characterWeight(segment),
      })),
    );
  };
  for (const match of findXUrls(text)) {
    appendText(text.slice(offset, match.index));
    tokens.push({ text: match.raw, weight: 23 });
    offset = match.lastIndex;
  }
  appendText(text.slice(offset));
  return tokens;
}

function xWeightedLength(text: string): number {
  return weightedTokens(text.normalize("NFC")).reduce((sum, token) => sum + token.weight, 0);
}

function appendVisibleWorkSession(text: string, sessions: XVisibleWorkSession[] = []): string {
  const session = sessions[0];
  const url = session?.url;
  const prefix = session?.publicRead === true ? "" : "Work session (sign-in required): ";
  return url && !text.includes(url) ? `${text.trimEnd()}\n${prefix}${url}` : text;
}

function chunkXReply(
  text: string,
  signature = DEFAULT_X_REPLY_SIGNATURE,
  hasMedia = false,
): string[] {
  const normalized = text.normalize("NFC").trim();
  const suffix = signature.normalize("NFC").trim();
  if (!normalized && !hasMedia) {
    throw new Error("X replies require text or an attachment");
  }
  if (xWeightedLength(suffix) > 280) {
    throw new Error("X replySignature exceeds 280 weighted characters");
  }
  if (!normalized) {
    return [suffix];
  }
  const tokens = weightedTokens(normalized);
  const chunks: string[] = [];
  let offset = 0;
  while (offset < tokens.length) {
    let end = offset;
    let weight = 0;
    let boundary = -1;
    while (end < tokens.length) {
      const token = tokens[end];
      if (!token || weight + token.weight > 280) {
        break;
      }
      weight += token.weight;
      if (/\s/u.test(token.text)) {
        boundary = end;
      }
      end++;
    }
    if (end === offset) {
      throw new Error("X reply contains a character sequence longer than one post");
    }
    if (end < tokens.length && boundary > offset) {
      end = boundary;
    }
    const chunk = tokens
      .slice(offset, end)
      .map((token) => token.text)
      .join("")
      .trim();
    if (chunk) {
      chunks.push(chunk);
    }
    offset = end;
    while (offset < tokens.length && /^\s+$/u.test(tokens[offset]?.text ?? "")) {
      offset++;
    }
  }
  if (suffix) {
    const last = chunks.at(-1)!;
    if (xWeightedLength(`${last}\n${suffix}`) <= 280) {
      chunks[chunks.length - 1] = `${last}\n${suffix}`;
    } else {
      chunks.push(suffix);
    }
  }
  return chunks;
}

function rethrowReplyAuthorizationError(cause: unknown): never {
  if (cause instanceof XAllowlistChangedError) {
    throw new PlatformMessageNotDispatchedError("X reply allowlist changed during authorization.", {
      cause,
      retryable: false,
    });
  }
  throw cause;
}

function xReceipt(postIds: string[], replyToId: string, hasMedia = false) {
  const receipt = createMessageReceiptFromOutboundResults({
    results: postIds.map((messageId) => ({ channel: "x", messageId, conversationId: replyToId })),
    kind: "text",
    replyToId,
  });
  if (hasMedia && receipt.parts[0]) {
    receipt.parts[0].kind = "media";
  }
  return receipt;
}

export async function sendXDelivery(
  params: Pick<OutboundMediaLoadOptions, "mediaAccess" | "mediaLocalRoots" | "mediaReadFile"> & {
    cfg: OpenClawConfig;
    accountId?: string | null;
    to: string;
    text: string;
    mediaUrl?: string;
    mediaUrls?: readonly string[];
    signal?: AbortSignal;
    mention?: XPost;
    senderTier?: XSenderTier;
    visibleWorkSessions?: XVisibleWorkSession[];
    onPlatformSendDispatch?: () => Promise<void>;
    onDeliveryResult?: (result: {
      channel: "x";
      messageId: string;
      receipt: ReturnType<typeof xReceipt>;
    }) => Promise<void> | void;
    assertDirectAdapterHandoff?: () => void;
    sessionKey?: string | null;
  },
) {
  const mediaUrls = [
    ...new Set([...(params.mediaUrl ? [params.mediaUrl] : []), ...(params.mediaUrls ?? [])]),
  ];
  const replyToId = normalizeXReplyTarget(params.to);
  if (!replyToId) {
    throw new PlatformMessageNotDispatchedError(
      "X requires a reply target: x:<postId> or https://x.com/<handle>/status/<postId>.",
      { cause: undefined, retryable: false },
    );
  }
  const readConfig = createRuntimeConfigReader(params.cfg);
  const runtime = getXRuntime();
  const origin = params.sessionKey
    ? await resolveXWorkOrigin(runtime, params.sessionKey, params.cfg)
    : undefined;
  const assertHandoff = () => {
    try {
      params.signal?.throwIfAborted();
      params.assertDirectAdapterHandoff?.();
      if (getXRuntime() !== runtime) {
        throw new Error("X reply runtime was replaced");
      }
    } catch (cause) {
      if (cause instanceof PlatformMessageNotDispatchedError) {
        throw cause;
      }
      throw new PlatformMessageNotDispatchedError(
        cause instanceof Error ? cause.message : "X reply authority was revoked",
        { cause, retryable: false },
      );
    }
  };
  let account: ReturnType<typeof resolveXAccount>;
  let api: XApiClient;
  let mention: XPost;
  try {
    account = resolveXAccount(params.cfg, params.accountId ?? origin?.accountId);
    api = await getXApi(account.accountId, params.cfg);
    assertHandoff();
    const resolvedMention =
      params.mention ??
      (
        await resolveXRecipient({
          api,
          post: replyToId,
          userId: account.userId,
          signal: params.signal,
          allowQuote: !origin || replyToId === origin.postId,
        })
      )?.post;
    if (!resolvedMention) {
      throw new PlatformMessageNotDispatchedError(
        "X only replies to posts that mention or quote this bot account and are available.",
        { cause: undefined, retryable: false },
      );
    }
    mention = resolvedMention;
    if (
      origin &&
      (origin.accountId !== account.accountId ||
        (replyToId !== origin.postId && mention.conversation_id !== origin.conversationId))
    ) {
      throw new PlatformMessageNotDispatchedError(
        `This X work session may reply only to its origin post (${origin.postUrl}) or a bot mention in that conversation.`,
        { cause: undefined, retryable: false },
      );
    }
  } catch (cause) {
    if (cause instanceof PlatformMessageNotDispatchedError) {
      throw cause;
    }
    throw new PlatformMessageNotDispatchedError(
      cause instanceof Error ? cause.message : "X reply preparation failed",
      { cause, retryable: !(cause instanceof XBudgetExceededError) && !params.signal?.aborted },
    );
  }
  const assertActive = async () => {
    assertHandoff();
    const cfg = readConfig();
    const current = resolveXAccount(cfg, account.accountId);
    if (
      !current.enabled ||
      current.userId !== account.userId ||
      mention.author_id === current.userId
    ) {
      throw new PlatformMessageNotDispatchedError(
        "X reply author is no longer allowed or the account changed.",
        {
          cause: undefined,
          retryable: false,
        },
      );
    }
    const authorization = await resolveXIngress(account.accountId, mention, cfg).catch(
      rethrowReplyAuthorizationError,
    );
    if (
      !authorization.ingress.senderAccess.allowed ||
      (params.senderTier && authorization.tier !== params.senderTier)
    ) {
      throw new PlatformMessageNotDispatchedError("X reply author is no longer allowed.", {
        cause: undefined,
        retryable: false,
      });
    }
    if (mediaUrls.length && authorization.tier !== "maintainer") {
      throw new PlatformMessageNotDispatchedError(
        "X media replies require an allowlisted maintainer.",
        {
          cause: undefined,
          retryable: false,
        },
      );
    }
    const assertCurrent = () => {
      assertHandoff();
      try {
        authorization.assertCurrent();
      } catch (cause) {
        rethrowReplyAuthorizationError(cause);
      }
      if (cfg !== readConfig()) {
        throw new PlatformMessageNotDispatchedError(
          "X reply policy changed during authorization; retry the reply",
          { cause: undefined },
        );
      }
    };
    assertCurrent();
    return assertCurrent;
  };
  // Authorize before reading local files or fetching remote attachments; the API rechecks
  // this same authority immediately before every upload and reply request.
  if (mediaUrls.length) {
    await assertActive();
  }
  const mediaSignal = params.signal;
  const media: XMedia[] = [];
  try {
    if (mediaUrls.length > 4) {
      throw new Error("X supports up to four images or one video/GIF per reply.");
    }
    for (const url of mediaUrls) {
      mediaSignal?.throwIfAborted();
      const loadedMedia = await loadOutboundMediaFromUrl(url, {
        ...params,
        maxBytes: MAX_VIDEO_BYTES,
        optimizeImages: false,
        requestInit: { signal: mediaSignal },
      });
      const contentType = loadedMedia.contentType ?? "";
      const mediaCategory =
        contentType === "video/mp4"
          ? "tweet_video"
          : contentType === "image/gif"
            ? "tweet_gif"
            : ["image/jpeg", "image/png", "image/webp"].includes(contentType)
              ? "tweet_image"
              : undefined;
      if (!mediaCategory) {
        throw new Error("X attachments must be JPEG, PNG, WebP, GIF, or MP4 video.");
      }
      const maxBytes =
        mediaCategory === "tweet_video"
          ? MAX_VIDEO_BYTES
          : (mediaCategory === "tweet_gif" ? 15 : 5) * 1024 * 1024;
      if (loadedMedia.buffer.length > maxBytes) {
        throw new Error(
          `X ${mediaCategory} exceeds the ${maxBytes / (1024 * 1024)} MiB attachment limit.`,
        );
      }
      if (mediaUrls.length > 1 && mediaCategory !== "tweet_image") {
        throw new Error(
          "X video and GIF replies require exactly one attachment; do not mix them with images.",
        );
      }
      media.push({
        buffer: loadedMedia.buffer,
        contentType,
        fileName: loadedMedia.fileName ?? "proof",
        mediaCategory,
      });
    }
  } catch (cause) {
    throw new PlatformMessageNotDispatchedError(
      cause instanceof Error ? cause.message : "X attachment could not be loaded",
      { cause, retryable: false },
    );
  }
  const logger = runtime.logging.getChildLogger({ channel: "x", accountId: account.accountId });
  const replyText = params.text;
  const signature = account.config.replySignature;
  const visibleWorkSessions =
    params.senderTier === "guest" ? undefined : params.visibleWorkSessions;
  const signal = params.signal;
  let chunks: string[];
  try {
    chunks = chunkXReply(
      appendVisibleWorkSession(replyText, visibleWorkSessions),
      signature,
      Boolean(media.length),
    );
  } catch (cause) {
    throw new PlatformMessageNotDispatchedError(
      cause instanceof Error ? cause.message : "X reply text could not be prepared",
      { cause, retryable: false },
    );
  }
  const postIds: string[] = [];
  const mediaIds: string[] = [];
  // Failed uploads must never degrade to a caption-only post. Unattached uploads
  // expire at X; retrying preparation cannot duplicate a visible reply.
  for (const attachment of media) {
    mediaIds.push(await api.uploadMedia({ ...attachment, signal, assertActive }));
  }
  try {
    for (const text of chunks) {
      if (signal?.aborted) {
        throw new PlatformMessageNotDispatchedError("X reply was aborted before dispatch", {
          cause: signal.reason,
          retryable: false,
        });
      }
      // Uploads and X processing can outlast queue custody; re-check it before each visible post.
      await params.onPlatformSendDispatch?.();
      const id = await api.reply({
        text,
        ...(postIds.length === 0 && mediaIds.length ? { mediaIds } : {}),
        inReplyToId: postIds.at(-1) ?? replyToId,
        signal,
        assertActive,
      });
      postIds.push(id);
    }
  } catch (cause) {
    if (postIds.length) {
      logger.warn(`partial reply posts=${postIds.join(",")}`);
      const receipt = xReceipt(postIds, replyToId, media.length > 0);
      // Report sent posts first: a not-dispatched cause alone would mark the whole reply as unsent.
      await params.onDeliveryResult?.({ channel: "x", messageId: postIds.at(-1) ?? "", receipt });
      throw createChannelPartialDeliveryError(
        new Error("X reply chain failed after one or more posts were sent", { cause }),
        {
          visibleReplySent: true,
          content: chunks.slice(0, postIds.length).join("\n"),
          receipt,
        },
      );
    }
    throw cause;
  }
  logger.info(`reply posts=${postIds.join(",")}`);
  return {
    channel: "x" as const,
    messageId: postIds.at(-1) ?? "",
    receipt: xReceipt(postIds, replyToId, media.length > 0),
    content: chunks.join("\n"),
  };
}
