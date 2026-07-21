// Mattermost plugin module implements reply delivery behavior.
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import {
  deliverTextOrMediaReply,
  isReasoningReplyPayload,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type {
  ReplyDispatchKind,
  ReplyFollowupAdmissionBarrierTimeoutPolicy,
  ReplyPayload,
} from "openclaw/plugin-sdk/reply-runtime";
import {
  resolveMattermostReplyDeliveryBarrierTimeoutMs,
  type CreateDmChannelRetryOptions,
} from "./client.js";
import {
  createMattermostPartialReplyDeliveryError,
  createMattermostReplyDeliveryResult,
  type MattermostReplyDeliveryResult,
  type MattermostReplyDeliverySource,
} from "./reply-delivery-result.js";

export {
  isMattermostReplyDeliveryVisible,
  type MattermostReplyDeliveryOutcome,
} from "./reply-delivery-result.js";

type MarkdownTableMode = Parameters<PluginRuntime["channel"]["text"]["convertMarkdownTables"]>[1];

type SendMattermostMessage = (
  to: string,
  text: string,
  opts: {
    cfg: OpenClawConfig;
    accountId?: string;
    mediaUrl?: string;
    mediaLocalRoots?: readonly string[];
    replyToId?: string;
    onDmChannelResolution?: (resolution: PromiseLike<unknown>) => void;
  },
) => Promise<MattermostReplyDeliverySource>;

export function createMattermostReplyDeliveryBarrier(params: {
  isDirect: boolean;
  dmRetryOptions?: CreateDmChannelRetryOptions;
}) {
  let activeDmChannelResolutions = 0;
  let queuedDeliveryCount = 0;
  let settledDeliveryCount = 0;
  const trackDmChannelResolution = (resolution: PromiseLike<unknown>) => {
    activeDmChannelResolutions += 1;
    void Promise.resolve(resolution).then(
      () => {
        activeDmChannelResolutions -= 1;
      },
      () => {
        activeDmChannelResolutions -= 1;
      },
    );
  };
  const markDeliverySettled = () => {
    settledDeliveryCount += 1;
  };
  const resolveTimeoutPolicy = (context: {
    queuedCounts: Readonly<Record<ReplyDispatchKind, number>>;
    humanDelayBudgetMs: number;
  }): ReplyFollowupAdmissionBarrierTimeoutPolicy | undefined => {
    const { queuedCounts } = context;
    queuedDeliveryCount = Object.values(queuedCounts).reduce((sum, count) => sum + count, 0);
    const maxTimeoutMs = resolveMattermostReplyDeliveryBarrierTimeoutMs({
      isDirect: params.isDirect,
      dmRetryOptions: params.dmRetryOptions,
      queuedCounts,
      humanDelayBudgetMs: context.humanDelayBudgetMs,
    });
    if (maxTimeoutMs === undefined) {
      return undefined;
    }
    return {
      maxTimeoutMs,
      shouldExtend: () =>
        activeDmChannelResolutions > 0 || settledDeliveryCount < queuedDeliveryCount,
    };
  };
  return {
    trackDmChannelResolution,
    markDeliverySettled,
    resolveTimeoutPolicy,
  };
}

export async function deliverMattermostReplyPayload(params: {
  core: PluginRuntime;
  cfg: OpenClawConfig;
  payload: ReplyPayload;
  to: string;
  accountId: string;
  agentId?: string;
  replyToId?: string;
  textLimit: number;
  tableMode: MarkdownTableMode;
  sendMessage: SendMattermostMessage;
  onDmChannelResolution?: (resolution: PromiseLike<unknown>) => void;
}): Promise<MattermostReplyDeliveryResult> {
  if (isReasoningReplyPayload(params.payload)) {
    return createMattermostReplyDeliveryResult({ outcome: "reasoning_skipped" });
  }
  const reply = resolveSendableOutboundReplyParts(params.payload, {
    text: params.core.channel.text.convertMarkdownTables(
      params.payload.text ?? "",
      params.tableMode,
    ),
  });
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(params.cfg, params.agentId);
  const chunkMode = params.core.channel.text.resolveChunkMode(
    params.cfg,
    "mattermost",
    params.accountId,
  );
  const results: MattermostReplyDeliverySource[] = [];
  let attemptedKind: "text" | "media" = "text";
  try {
    const outcome = await deliverTextOrMediaReply({
      payload: params.payload,
      text: reply.text,
      chunkText: (value) =>
        params.core.channel.text.chunkMarkdownTextWithMode(value, params.textLimit, chunkMode),
      sendText: async (chunk) => {
        attemptedKind = "text";
        results.push(
          await params.sendMessage(params.to, chunk, {
            cfg: params.cfg,
            accountId: params.accountId,
            replyToId: params.replyToId,
            ...(params.onDmChannelResolution
              ? { onDmChannelResolution: params.onDmChannelResolution }
              : {}),
          }),
        );
      },
      sendMedia: async ({ mediaUrl, caption }) => {
        attemptedKind = "media";
        results.push(
          await params.sendMessage(params.to, caption ?? "", {
            cfg: params.cfg,
            accountId: params.accountId,
            mediaUrl,
            mediaLocalRoots,
            replyToId: params.replyToId,
            ...(params.onDmChannelResolution
              ? { onDmChannelResolution: params.onDmChannelResolution }
              : {}),
          }),
        );
      },
    });
    return createMattermostReplyDeliveryResult({ outcome, results });
  } catch (error) {
    throw createMattermostPartialReplyDeliveryError(
      error,
      createMattermostReplyDeliveryResult({
        outcome: results.length > 0 ? attemptedKind : "empty",
        results,
      }),
      [{ kind: attemptedKind, index: results.length }],
    );
  }
}
