import {
  resolveOutboundSendDep,
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
import { createMSTeamsPollStoreState } from "./polls.js";
import { buildMSTeamsPresentationCard, MSTEAMS_PRESENTATION_CAPABILITIES } from "./presentation.js";
import { sendAdaptiveCardMSTeams, sendMessageMSTeams, sendPollMSTeams } from "./send.js";

const MSTEAMS_TEXT_CHUNK_LIMIT = 4000;

function resolveMSTeamsEffectiveTextChunkLimit(configuredLimit?: number): number {
  return typeof configuredLimit === "number" && configuredLimit > 0
    ? Math.min(configuredLimit, MSTEAMS_TEXT_CHUNK_LIMIT)
    : MSTEAMS_TEXT_CHUNK_LIMIT;
}

type MSTeamsSendConfig = Parameters<typeof sendMessageMSTeams>[0]["cfg"];
type MSTeamsSendResult = { messageId: string; conversationId: string };
type MSTeamsSendOptions = Pick<
  Parameters<typeof sendMessageMSTeams>[0],
  "assertDirectAdapterHandoff" | "onPlatformSendDispatch" | "onDeliveryResult"
>;
type MSTeamsMediaSendOptions = Pick<
  Parameters<typeof sendMessageMSTeams>[0],
  "mediaUrl" | "mediaAccess" | "mediaLocalRoots" | "mediaReadFile"
> &
  MSTeamsSendOptions;
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
): Promise<MSTeamsSendResult> {
  if (!onDeliveryResult) {
    return send(undefined);
  }
  let childReported = false;
  const result = await send(async (delivery) => {
    childReported = true;
    await onDeliveryResult(attachChannelToResult("msteams", toMSTeamsOutboundResult(delivery)));
  });
  // Injected send dependencies can return only their final result. Native sends
  // already report each accepted activity before a later send can fail.
  if (!childReported) {
    await onDeliveryResult(attachChannelToResult("msteams", toMSTeamsOutboundResult(result)));
  }
  return result;
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
  deps?: OutboundSendDeps;
}): MSTeamsSendFn {
  return (
    resolveOutboundSendDep<MSTeamsSendFn>(params.deps, "msteams") ??
    ((to, text, opts) => sendMessageMSTeams({ cfg: params.cfg, to, text, ...opts }))
  );
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
  deliveryMode: "direct",
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown",
  textChunkLimit: MSTEAMS_TEXT_CHUNK_LIMIT,
  resolveEffectiveTextChunkLimit: ({ fallbackLimit }) =>
    resolveMSTeamsEffectiveTextChunkLimit(fallbackLimit),
  pollMaxOptions: 12,
  deliveryCapabilities: {
    durableFinal: {
      text: true,
      media: true,
      payload: true,
      messageSendingHooks: true,
    },
  },
  presentationCapabilities: MSTEAMS_PRESENTATION_CAPABILITIES,
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
    deps,
    onDeliveryResult,
    assertDirectAdapterHandoff,
    onPlatformSendDispatch,
    threadId,
  }) => {
    const handoff = { assertDirectAdapterHandoff, onPlatformSendDispatch };
    const deliveryTarget = resolveMSTeamsThreadTarget(to, threadId);
    const msteamsData = asOptionalRecord(payload.channelData?.msteams);
    const presentationCard = msteamsData?.presentationCard;
    if (
      presentationCard &&
      typeof presentationCard === "object" &&
      !Array.isArray(presentationCard)
    ) {
      const result = await sendWithDeliveryResults(
        (report) =>
          sendAdaptiveCardMSTeams({
            cfg,
            to: deliveryTarget,
            card: presentationCard as Record<string, unknown>,
            ...handoff,
            onDeliveryResult: report,
          }),
        onDeliveryResult,
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
      const send = resolveMSTeamsSend({ cfg, deps });
      const result = await sendPayloadMediaSequence<MSTeamsSendResult>({
        text,
        mediaUrls,
        send: async ({ text: textLocal, mediaUrl: mediaUrlLocal }) =>
          await sendWithDeliveryResults(
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
          ),
      });
      if (result) {
        return attachChannelToResult("msteams", toMSTeamsOutboundResult(result));
      }
    }
    if (text.trim()) {
      const send = resolveMSTeamsSend({ cfg, deps });
      const chunks = resolveTextChunksWithFallback(
        text,
        chunkTextForOutbound(
          text,
          resolveMSTeamsEffectiveTextChunkLimit(cfg.channels?.msteams?.textChunkLimit),
        ),
      );
      let result: Awaited<ReturnType<MSTeamsSendFn>>;
      for (const chunk of chunks) {
        result = await sendWithDeliveryResults(
          (report) => send(deliveryTarget, chunk, { ...handoff, onDeliveryResult: report }),
          onDeliveryResult,
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
      threadId,
      assertDirectAdapterHandoff,
      onPlatformSendDispatch,
    }) => {
      const maxSelections = poll.maxSelections ?? 1;
      const result = await sendPollMSTeams({
        cfg,
        to: resolveMSTeamsThreadTarget(to, threadId),
        question: poll.question,
        options: poll.options,
        maxSelections,
        assertDirectAdapterHandoff,
        onPlatformSendDispatch,
      });
      const pollStore = createMSTeamsPollStoreState();
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
