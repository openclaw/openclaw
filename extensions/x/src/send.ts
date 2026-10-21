import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import type { OutboundMediaLoadOptions } from "openclaw/plugin-sdk/outbound-media";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveXAccount } from "./accounts.js";
import { XAllowlistChangedError } from "./allowlist.js";
import type { XApiClient, XPost } from "./api.js";
import { getXApi } from "./client.js";
import type { XSenderTier } from "./guest-policy.js";
import { resolveXIngress } from "./ingress.js";
import { loadXMedia } from "./media.js";
import { resolveXRecipient } from "./recipient.js";
import { sendXReply, XPartialReplyError, type XVisibleWorkSession } from "./reply.js";
import { getXRuntime } from "./runtime.js";
import { XBudgetExceededError } from "./spend.js";
import { normalizeXReplyTarget } from "./target.js";
import { resolveXWorkOrigin } from "./work-origin.js";

function rethrowReplyAuthorizationError(cause: unknown): never {
  if (cause instanceof XAllowlistChangedError) {
    throw new PlatformMessageNotDispatchedError("X reply allowlist changed during authorization.", {
      cause,
      retryable: false,
    });
  }
  throw cause;
}

export function xReceipt(postIds: string[], replyToId: string, hasMedia = false) {
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
  const media = await loadXMedia(mediaUrls, params, params.signal);
  const logger = runtime.logging.getChildLogger({ channel: "x", accountId: account.accountId });
  try {
    const result = await sendXReply({
      api,
      text: params.text,
      media,
      replyToId,
      signature: account.config.replySignature,
      visibleWorkSessions: params.senderTier === "guest" ? undefined : params.visibleWorkSessions,
      signal: params.signal,
      assertActive,
    });
    logger.info(`reply posts=${result.postIds.join(",")}`);
    return {
      channel: "x" as const,
      messageId: result.postIds.at(-1) ?? "",
      receipt: xReceipt(result.postIds, replyToId, media.length > 0),
      content: result.text,
    };
  } catch (error) {
    if (error instanceof XPartialReplyError) {
      logger.warn(`partial reply posts=${error.postIds.join(",")}`);
      throw createChannelPartialDeliveryError(error, {
        visibleReplySent: true,
        content: error.text,
        receipt: xReceipt(error.postIds, replyToId, media.length > 0),
      });
    }
    throw error;
  }
}
