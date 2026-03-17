import { buildImageAnnotation } from "../../../../../src/auto-reply/annotate-thread-images.js";
import { formatInboundEnvelope } from "../../../../../src/auto-reply/envelope.js";
import { readSessionUpdatedAt } from "../../../../../src/config/sessions.js";
import { logVerbose } from "../../../../../src/globals.js";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackFile, SlackMessageEvent } from "../../types.js";
import type { SlackMonitorContext } from "../context.js";
import {
  resolveSlackMedia,
  resolveSlackThreadHistory,
  type SlackMediaResult,
  type SlackThreadStarter,
} from "../media.js";

/** Image MIME type prefixes that indicate a visual image file. */
const IMAGE_MIME_PREFIX = "image/";

/** Check whether a Slack file looks like an image based on its MIME type or name. */
function isImageFile(file: SlackFile): boolean {
  if (file.mimetype?.toLowerCase().startsWith(IMAGE_MIME_PREFIX)) {
    return true;
  }
  const name = file.name?.toLowerCase() ?? "";
  return /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|svg)$/.test(name);
}

export type SlackThreadContextData = {
  threadStarterBody: string | undefined;
  threadHistoryBody: string | undefined;
  threadSessionPreviousTimestamp: number | undefined;
  threadLabel: string | undefined;
  threadStarterMedia: SlackMediaResult[] | null;
};

export async function resolveSlackThreadContextData(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  isThreadReply: boolean;
  threadTs: string | undefined;
  threadStarter: SlackThreadStarter | null;
  roomLabel: string;
  storePath: string;
  sessionKey: string;
  envelopeOptions: ReturnType<
    typeof import("../../../../../src/auto-reply/envelope.js").resolveEnvelopeFormatOptions
  >;
  effectiveDirectMedia: SlackMediaResult[] | null;
}): Promise<SlackThreadContextData> {
  let threadStarterBody: string | undefined;
  let threadHistoryBody: string | undefined;
  let threadSessionPreviousTimestamp: number | undefined;
  let threadLabel: string | undefined;
  let threadStarterMedia: SlackMediaResult[] | null = null;

  if (!params.isThreadReply || !params.threadTs) {
    return {
      threadStarterBody,
      threadHistoryBody,
      threadSessionPreviousTimestamp,
      threadLabel,
      threadStarterMedia,
    };
  }

  const starter = params.threadStarter;
  if (starter?.text) {
    threadStarterBody = starter.text;
    const snippet = starter.text.replace(/\s+/g, " ").slice(0, 80);
    threadLabel = `Slack thread ${params.roomLabel}${snippet ? `: ${snippet}` : ""}`;
    if (!params.effectiveDirectMedia && starter.files && starter.files.length > 0) {
      threadStarterMedia = await resolveSlackMedia({
        files: starter.files,
        token: params.ctx.botToken,
        maxBytes: params.ctx.mediaMaxBytes,
      });
      if (threadStarterMedia) {
        const starterPlaceholders = threadStarterMedia.map((item) => item.placeholder).join(", ");
        logVerbose(`slack: hydrated thread starter file ${starterPlaceholders} from root message`);
      }
    }
  } else {
    threadLabel = `Slack thread ${params.roomLabel}`;
  }

  const threadInitialHistoryLimit = params.account.config?.thread?.initialHistoryLimit ?? 20;
  const annotateImages = params.account.config?.thread?.annotateImages ?? true;
  threadSessionPreviousTimestamp = readSessionUpdatedAt({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
  });

  if (threadInitialHistoryLimit > 0 && !threadSessionPreviousTimestamp) {
    const threadHistory = await resolveSlackThreadHistory({
      channelId: params.message.channel,
      threadTs: params.threadTs,
      client: params.ctx.app.client,
      currentMessageTs: params.message.ts,
      limit: threadInitialHistoryLimit,
    });

    if (threadHistory.length > 0) {
      const uniqueUserIds = [
        ...new Set(
          threadHistory.map((item) => item.userId).filter((id): id is string => Boolean(id)),
        ),
      ];
      const userMap = new Map<string, { name?: string }>();
      await Promise.all(
        uniqueUserIds.map(async (id) => {
          const user = await params.ctx.resolveUserName(id);
          if (user) {
            userMap.set(id, user);
          }
        }),
      );

      const totalMessages = threadHistory.length;
      const historyParts: string[] = [];
      for (const [msgIndex, historyMsg] of threadHistory.entries()) {
        const msgUser = historyMsg.userId ? userMap.get(historyMsg.userId) : null;
        const msgSenderName =
          msgUser?.name ?? (historyMsg.botId ? `Bot (${historyMsg.botId})` : "Unknown");
        const isBot = Boolean(historyMsg.botId);
        const role = isBot ? "assistant" : "user";

        // Build image annotation lines for messages with image file attachments.
        let imageAnnotation = "";
        if (annotateImages && historyMsg.files && historyMsg.files.length > 0) {
          const imageFiles = historyMsg.files.filter(isImageFile);
          if (imageFiles.length > 0) {
            const annotations = imageFiles.map(() =>
              buildImageAnnotation({
                totalMessages,
                messageIndex: msgIndex + 1,
                timestamp: historyMsg.ts,
                author: `${msgSenderName} (${role})`,
                timezone: params.envelopeOptions?.timezone ?? "UTC",
              }),
            );
            imageAnnotation = "\n" + annotations.join("\n");
          }
        }

        const msgWithId = `${historyMsg.text}${imageAnnotation}\n[slack message id: ${historyMsg.ts ?? "unknown"} channel: ${params.message.channel}]`;
        historyParts.push(
          formatInboundEnvelope({
            channel: "Slack",
            from: `${msgSenderName} (${role})`,
            timestamp: historyMsg.ts ? Math.round(Number(historyMsg.ts) * 1000) : undefined,
            body: msgWithId,
            chatType: "channel",
            envelope: params.envelopeOptions,
          }),
        );
      }
      threadHistoryBody = historyParts.join("\n\n");
      logVerbose(
        `slack: populated thread history with ${threadHistory.length} messages for new session`,
      );
    }
  }

  return {
    threadStarterBody,
    threadHistoryBody,
    threadSessionPreviousTimestamp,
    threadLabel,
    threadStarterMedia,
  };
}
