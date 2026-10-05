import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveXAccount } from "./accounts.js";
import type { XApiClient, XPost } from "./api.js";
import { getXApi } from "./client.js";
import { resolveXIngress } from "./ingress.js";
import { resolveXRecipient } from "./recipient.js";
import { sendXReply, XPartialReplyError, type XVisibleWorkSession } from "./reply.js";
import { getXRuntime } from "./runtime.js";
import { normalizeXReplyTarget } from "./target.js";

export function xReceipt(postIds: string[], replyToId: string) {
  return createMessageReceiptFromOutboundResults({
    results: postIds.map((messageId) => ({ channel: "x", messageId, conversationId: replyToId })),
    kind: "text",
    replyToId,
  });
}

export async function sendXDelivery(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  text: string;
  mediaUrl?: string;
  mediaUrls?: readonly string[];
  signal?: AbortSignal;
  mention?: XPost;
  visibleWorkSessions?: XVisibleWorkSession[];
  assertDirectAdapterHandoff?: () => void;
}) {
  if (params.mediaUrl || params.mediaUrls?.length) {
    throw new PlatformMessageNotDispatchedError(
      "X supports text replies only; media is not supported.",
      {
        cause: undefined,
        retryable: false,
      },
    );
  }
  const replyToId = normalizeXReplyTarget(params.to);
  if (!replyToId) {
    throw new PlatformMessageNotDispatchedError(
      "X requires a reply target: x:<postId> or https://x.com/<handle>/status/<postId>.",
      { cause: undefined, retryable: false },
    );
  }
  const readConfig = createRuntimeConfigReader(params.cfg);
  const assertHandoff = () => {
    try {
      params.signal?.throwIfAborted();
      params.assertDirectAdapterHandoff?.();
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
  let prepared: {
    account: ReturnType<typeof resolveXAccount>;
    api: XApiClient;
    mention: XPost;
  };
  try {
    const resolvedAccount = resolveXAccount(params.cfg, params.accountId);
    const resolvedApi = await getXApi(resolvedAccount.accountId, params.cfg);
    assertHandoff();
    const resolvedMention =
      params.mention ??
      (
        await resolveXRecipient({
          api: resolvedApi,
          post: replyToId,
          userId: resolvedAccount.userId,
          signal: params.signal,
        })
      )?.post;
    if (!resolvedMention) {
      throw new PlatformMessageNotDispatchedError(
        "X only replies to posts that mention or quote this bot account and are available.",
        { cause: undefined, retryable: false },
      );
    }
    prepared = { account: resolvedAccount, api: resolvedApi, mention: resolvedMention };
  } catch (cause) {
    if (cause instanceof PlatformMessageNotDispatchedError) {
      throw cause;
    }
    throw new PlatformMessageNotDispatchedError(
      cause instanceof Error ? cause.message : "X reply preparation failed",
      { cause, retryable: !params.signal?.aborted },
    );
  }
  const { account, api, mention } = prepared;
  const assertActive = async () => {
    assertHandoff();
    const cfg = readConfig();
    const current = resolveXAccount(cfg, account.accountId);
    if (
      !current.enabled ||
      current.userId !== account.userId ||
      mention.author_id === current.userId ||
      !(await resolveXIngress(account.accountId, mention, cfg)).senderAccess.allowed
    ) {
      throw new PlatformMessageNotDispatchedError(
        "X reply author is no longer allowed or the account changed.",
        {
          cause: undefined,
          retryable: false,
        },
      );
    }
    assertHandoff();
    if (cfg !== readConfig()) {
      throw new PlatformMessageNotDispatchedError(
        "X reply policy changed during authorization; retry the reply",
        {
          cause: undefined,
        },
      );
    }
  };
  try {
    const result = await sendXReply({
      api,
      text: params.text,
      replyToId,
      signature: account.config.replySignature,
      visibleWorkSessions: params.visibleWorkSessions,
      signal: params.signal,
      assertActive,
    });
    getXRuntime()
      .logging.getChildLogger({ channel: "x", accountId: account.accountId })
      .info(`reply posts=${result.postIds.join(",")}`);
    return {
      channel: "x" as const,
      messageId: result.postIds.at(-1) ?? "",
      receipt: xReceipt(result.postIds, replyToId),
      content: result.text,
    };
  } catch (error) {
    if (error instanceof XPartialReplyError) {
      getXRuntime()
        .logging.getChildLogger({ channel: "x", accountId: account.accountId })
        .warn(`partial reply posts=${error.postIds.join(",")}`);
      throw createChannelPartialDeliveryError(error, {
        visibleReplySent: true,
        content: error.text,
        receipt: xReceipt(error.postIds, replyToId),
      });
    }
    throw error;
  }
}
