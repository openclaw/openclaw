import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  resolveOutboundSendDep,
  type MessageReceipt,
  type OutboundSendDeps,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  attachChannelToResult,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import {
  resolvePayloadMediaUrls,
  resolveTextChunksWithFallback,
  sendPayloadMediaSequence,
} from "openclaw/plugin-sdk/reply-payload";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  chunkTextForOutbound,
  normalizeStringEntries,
  type ChannelOutboundAdapter,
} from "../runtime-api.js";
import { resolveDefaultMSTeamsAccountId, resolveMSTeamsAccountConfig } from "./accounts.js";
import { msteamsOutboundConfig, resolveMSTeamsEffectiveTextChunkLimit } from "./outbound-config.js";
import { createMSTeamsPollStoreState } from "./polls.js";
import { buildMSTeamsPresentationCard } from "./presentation.js";
import { sendAdaptiveCardMSTeams, sendMessageMSTeams, sendPollMSTeams } from "./send.js";

type MSTeamsSendConfig = Parameters<typeof sendMessageMSTeams>[0]["cfg"];
type MSTeamsSendResult = { messageId: string; conversationId: string; receipt?: MessageReceipt };
type MSTeamsSendOptions = Pick<
  Parameters<typeof sendMessageMSTeams>[0],
  "assertDirectAdapterHandoff" | "onPlatformSendDispatch" | "onDeliveryResult"
>;
type MSTeamsMediaSendOptions = Pick<
  Parameters<typeof sendMessageMSTeams>[0],
  "mediaUrl" | "mediaAccess" | "mediaLocalRoots" | "mediaReadFile"
> &
  MSTeamsSendOptions & { cfg?: MSTeamsSendConfig; accountId?: string | null };
type MSTeamsSendFn = (
  to: string,
  text: string,
  opts?: MSTeamsMediaSendOptions,
) => Promise<MSTeamsSendResult>;

function toMSTeamsOutboundResult(result: MSTeamsSendResult) {
  const { conversationId, ...delivery } = result;
  return { ...delivery, target: { kind: "conversation" as const, id: conversationId } };
}

async function sendWithDeliveryResults(
  send: (onDeliveryResult: MSTeamsSendOptions["onDeliveryResult"]) => Promise<MSTeamsSendResult>,
  onDeliveryResult: Parameters<
    NonNullable<ChannelOutboundAdapter["sendText"]>
  >[0]["onDeliveryResult"],
  acceptedResults: MSTeamsSendResult[] = [],
): Promise<MSTeamsSendResult> {
  const acceptedBeforeSend = acceptedResults.length;
  try {
    let childReported = false;
    const result = await send(
      onDeliveryResult
        ? async (delivery) => {
            childReported = true;
            acceptedResults.push(delivery);
            await onDeliveryResult(
              attachChannelToResult("msteams", toMSTeamsOutboundResult(delivery)),
            );
          }
        : undefined,
    );
    // Injected send dependencies can return only their final result. Native sends
    // already report each accepted activity before a later send can fail.
    if (!childReported) {
      acceptedResults.push(result);
      if (onDeliveryResult) {
        await onDeliveryResult(attachChannelToResult("msteams", toMSTeamsOutboundResult(result)));
      }
    }
    return result;
  } catch (error) {
    const partial = isChannelPartialDeliveryError(error) ? error : undefined;
    // A native partial receipt already includes this send's progress observations.
    const earlierResults = partial ? acceptedResults.slice(0, acceptedBeforeSend) : acceptedResults;
    if (earlierResults.length === 0) {
      throw error;
    }
    const receipt = createMessageReceiptFromOutboundResults({
      results: [
        ...earlierResults.map((result) => attachChannelToResult("msteams", result)),
        ...(partial?.deliveryResult.receipt
          ? [{ receipt: partial.deliveryResult.receipt }]
          : (partial?.deliveryResult.messageIds ?? []).map((messageId) => ({
              channel: "msteams",
              messageId,
            }))),
      ],
    });
    throw createChannelPartialDeliveryError(partial?.cause ?? error, {
      ...partial?.deliveryResult,
      messageIds: receipt.platformMessageIds,
      receipt,
      visibleReplySent: true,
    });
  }
}

function resolveMSTeamsThreadTarget(to: string, threadId?: string | number | null) {
  const normalizedThreadId = threadId == null ? "" : String(threadId).trim();
  const graphChannelId = to.includes("/") ? to.slice(to.indexOf("/") + 1) : "";
  const isConversationTarget =
    to.startsWith("conversation:") ||
    to.startsWith("19:") ||
    graphChannelId.startsWith("19:") ||
    graphChannelId.includes("@thread");
  // Keep the resolved root on the target so proactive lookup and Connector
  // delivery use this turn's thread, not the latest stored conversation root.
  if (!normalizedThreadId || /(?:^|;)messageid=/iu.test(to) || !isConversationTarget) {
    return to;
  }
  return `${to};messageid=${normalizedThreadId}`;
}

function resolveMSTeamsSend(params: {
  cfg: MSTeamsSendConfig;
  accountId?: string | null;
  deps?: OutboundSendDeps;
}): MSTeamsSendFn {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultMSTeamsAccountId(params.cfg),
  );
  const send = resolveOutboundSendDep<MSTeamsSendFn>(params.deps, "msteams");
  return (to, text, opts) =>
    send
      ? send(to, text, { ...opts, cfg: params.cfg, accountId })
      : sendMessageMSTeams({ ...opts, cfg: params.cfg, accountId, to, text });
}

async function sendMSTeamsOutbound(
  ctx: Parameters<NonNullable<ChannelOutboundAdapter["sendMedia"]>>[0],
  includeMedia: boolean,
) {
  const send = resolveMSTeamsSend(ctx);
  return toMSTeamsOutboundResult(
    await sendWithDeliveryResults(
      (report) =>
        send(resolveMSTeamsThreadTarget(ctx.to, ctx.threadId), ctx.text, {
          ...(includeMedia
            ? {
                mediaUrl: ctx.mediaUrl,
                mediaAccess: ctx.mediaAccess,
                mediaLocalRoots: ctx.mediaLocalRoots,
                mediaReadFile: ctx.mediaReadFile,
              }
            : {}),
          assertDirectAdapterHandoff: ctx.assertDirectAdapterHandoff,
          onPlatformSendDispatch: ctx.onPlatformSendDispatch,
          onDeliveryResult: report,
        }),
      ctx.onDeliveryResult,
    ),
  );
}

export const msteamsOutbound: ChannelOutboundAdapter = {
  ...msteamsOutboundConfig,
  renderPresentation: ({ payload, presentation }) => {
    if (payload.mediaUrl || payload.mediaUrls?.length) {
      return null;
    }
    const card = buildMSTeamsPresentationCard({
      presentation,
      text: payload.text,
    });
    const msteamsData = asOptionalRecord(payload.channelData?.msteams) ?? {};
    return {
      ...payload,
      channelData: {
        ...payload.channelData,
        msteams: {
          ...msteamsData,
          presentationCard: card,
        },
      },
    };
  },
  sendPayload: async ({
    cfg,
    to,
    text,
    mediaUrl,
    mediaAccess,
    mediaLocalRoots,
    mediaReadFile,
    payload,
    accountId,
    deps,
    onDeliveryResult,
    assertDirectAdapterHandoff,
    onPlatformSendDispatch,
    threadId,
  }) => {
    const effectiveAccountId = normalizeAccountId(accountId ?? resolveDefaultMSTeamsAccountId(cfg));
    const handoff = { assertDirectAdapterHandoff, onPlatformSendDispatch };
    const acceptedResults: MSTeamsSendResult[] = [];
    const deliveryTarget = resolveMSTeamsThreadTarget(to, threadId);
    const msteamsData = asOptionalRecord(payload.channelData?.msteams);
    const presentationCard = asOptionalRecord(msteamsData?.presentationCard);
    if (presentationCard) {
      const result = await sendWithDeliveryResults(
        (report) =>
          sendAdaptiveCardMSTeams({
            cfg,
            accountId: effectiveAccountId,
            to: deliveryTarget,
            card: presentationCard,
            ...handoff,
            onDeliveryResult: report,
          }),
        onDeliveryResult,
        acceptedResults,
      );
      return attachChannelToResult("msteams", toMSTeamsOutboundResult(result));
    }
    const mediaUrls = normalizeStringEntries(
      resolvePayloadMediaUrls({
        ...payload,
        mediaUrl: payload.mediaUrl ?? mediaUrl,
      }),
    );
    if (mediaUrls.length > 0) {
      const send = resolveMSTeamsSend({ cfg, accountId: effectiveAccountId, deps });
      const result = await sendPayloadMediaSequence<MSTeamsSendResult>({
        text,
        mediaUrls,
        send: ({ text: textLocal, mediaUrl: mediaUrlLocal }) =>
          sendWithDeliveryResults(
            (report) =>
              send(deliveryTarget, textLocal, {
                mediaUrl: mediaUrlLocal,
                mediaAccess,
                mediaLocalRoots,
                mediaReadFile,
                ...handoff,
                onDeliveryResult: report,
              }),
            onDeliveryResult,
            acceptedResults,
          ),
      });
      if (result) {
        return attachChannelToResult("msteams", toMSTeamsOutboundResult(result));
      }
    }
    if (text.trim()) {
      const send = resolveMSTeamsSend({ cfg, accountId: effectiveAccountId, deps });
      const chunks = resolveTextChunksWithFallback(
        text,
        chunkTextForOutbound(
          text,
          resolveMSTeamsEffectiveTextChunkLimit(
            resolveMSTeamsAccountConfig(cfg, effectiveAccountId).textChunkLimit,
          ),
        ),
      );
      let result: Awaited<ReturnType<MSTeamsSendFn>>;
      for (const chunk of chunks) {
        result = await sendWithDeliveryResults(
          (report) => send(deliveryTarget, chunk, { ...handoff, onDeliveryResult: report }),
          onDeliveryResult,
          acceptedResults,
        );
      }
      return attachChannelToResult("msteams", toMSTeamsOutboundResult(result!));
    }
    throw new Error("MS Teams payload send requires text, media, or a presentation card.");
  },
  ...createAttachedChannelResultAdapter({
    channel: "msteams",
    sendText: (ctx) => sendMSTeamsOutbound(ctx, false),
    sendMedia: (ctx) => sendMSTeamsOutbound(ctx, true),
    sendPoll: async ({
      cfg,
      to,
      poll,
      accountId,
      threadId,
      assertDirectAdapterHandoff,
      onPlatformSendDispatch,
    }) => {
      const effectiveAccountId = normalizeAccountId(
        accountId ?? resolveDefaultMSTeamsAccountId(cfg),
      );
      const maxSelections = poll.maxSelections ?? 1;
      const result = await sendPollMSTeams({
        cfg,
        accountId: effectiveAccountId,
        to: resolveMSTeamsThreadTarget(to, threadId),
        question: poll.question,
        options: poll.options,
        maxSelections,
        assertDirectAdapterHandoff,
        onPlatformSendDispatch,
      });
      const pollStore = createMSTeamsPollStoreState({ accountId: effectiveAccountId });
      await pollStore.createPoll({
        id: result.pollId,
        question: poll.question,
        options: poll.options,
        maxSelections,
        createdAt: new Date().toISOString(),
        conversationId: result.conversationId,
        messageId: result.messageId,
        votes: {},
      });
      return result;
    },
  }),
};
