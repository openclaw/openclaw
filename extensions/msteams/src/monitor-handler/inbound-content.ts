import { formatInboundMediaUnavailableText } from "openclaw/plugin-sdk/channel-inbound";
import {
  downloadMSTeamsBotFrameworkAttachments,
  isBotFrameworkPersonalChatId,
} from "../attachments/bot-framework.js";
import { downloadMSTeamsAttachments } from "../attachments/download.js";
import { buildMSTeamsGraphMessageUrl, downloadMSTeamsGraphMedia } from "../attachments/graph.js";
import { extractMSTeamsHtmlAttachmentIds } from "../attachments/html.js";
import type { MSTeamsHtmlAttachmentSummary, MSTeamsInboundMedia } from "../attachments/types.js";
import { formatUnknownError } from "../errors.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.types.js";
import {
  createMSTeamsInboundMediaDeadline,
  type MSTeamsRequestDeadline,
  withMSTeamsRequestDeadline,
} from "../request-timeout.js";
import type { MSTeamsDebounceEntry } from "./inbound-facts.js";

export async function prepareMSTeamsInboundContent(params: {
  entry: MSTeamsDebounceEntry;
  rawBody: string;
  advertisedMedia: MSTeamsInboundMedia[];
  htmlSummary?: MSTeamsHtmlAttachmentSummary;
  conversationType: string;
  conversationId: string;
  conversationMessageId?: string;
  teamAadGroupId?: string;
  resolveTeamAadGroupId: (deadline: MSTeamsRequestDeadline) => Promise<string | undefined>;
  mediaMaxBytes: number;
  tokenProvider: MSTeamsMessageHandlerDeps["tokenProvider"];
  mediaAllowHosts?: string[];
  mediaAuthAllowHosts?: string[];
  graphMediaFallback?: boolean;
  log: MSTeamsMessageHandlerDeps["log"];
}) {
  const activity = params.entry.context.activity;
  const mayRecoverGraphMedia =
    Boolean(params.htmlSummary?.attachmentIds.length) ||
    shouldAttemptMSTeamsGraphMediaFallback({
      conversationType: params.conversationType,
      htmlSummary: params.htmlSummary,
      graphMediaFallback: params.graphMediaFallback,
    });
  if (!params.rawBody && params.advertisedMedia.length === 0 && !mayRecoverGraphMedia) {
    params.log.debug?.("skipping empty message after stripping mentions");
    return null;
  }

  let resolvedMedia: MSTeamsInboundMedia[] = [];
  // Media is message content with its own transfer budget, separate from
  // optional enrichment, so slow Bot Framework downloads still reach the agent.
  const deadline = createMSTeamsInboundMediaDeadline();
  try {
    resolvedMedia = await withMSTeamsRequestDeadline({
      deadline,
      label: "MS Teams inbound media",
      work: async () => {
        let mediaList = await downloadMSTeamsAttachments({
          attachments: params.entry.attachments,
          maxBytes: params.mediaMaxBytes,
          tokenProvider: params.tokenProvider,
          allowHosts: params.mediaAllowHosts,
          authAllowHosts: params.mediaAuthAllowHosts,
          deadline,
          logger: params.log,
        });

        if (!hasMaterializedMedia(mediaList)) {
          // Explicit attachment markers remain the fallback gate for personal chats.
          // Channel and group-chat activities can omit them while Graph holds a file.
          const attachmentIds = extractMSTeamsHtmlAttachmentIds(params.entry.attachments);
          const hasHtmlFileAttachment = attachmentIds.length > 0;
          const shouldFetchGraphMessage =
            hasHtmlFileAttachment || shouldAttemptMSTeamsGraphMediaFallback(params);
          const isBotFrameworkPersonalChat = isBotFrameworkPersonalChatId(params.conversationId);

          // Bot Framework DM IDs are not Graph chat IDs; recover their files via
          // the Bot Framework v3 attachment endpoint instead.
          if (hasHtmlFileAttachment && isBotFrameworkPersonalChat) {
            if (!activity.serviceUrl) {
              params.log.debug?.("bot framework attachment skipped (missing serviceUrl)", {
                conversationType: params.conversationType,
                conversationId: params.conversationId,
              });
            } else {
              const bfMedia = await downloadMSTeamsBotFrameworkAttachments({
                serviceUrl: activity.serviceUrl,
                attachmentIds,
                tokenProvider: params.tokenProvider,
                maxBytes: params.mediaMaxBytes,
                allowHosts: params.mediaAllowHosts,
                authAllowHosts: params.mediaAuthAllowHosts,
                deadline,
              });
              mediaList = mergeMSTeamsMediaFacts(mediaList, bfMedia.media, {
                positionallyAligned: false,
              });
              if (!hasMaterializedMedia(bfMedia.media)) {
                params.log.debug?.("bot framework attachments fetch empty", {
                  conversationType: params.conversationType,
                  attachmentCount: bfMedia.attachmentCount ?? attachmentIds.length,
                });
              }
            }
          }

          if (shouldFetchGraphMessage && !isBotFrameworkPersonalChat) {
            const graphTeamAadGroupId =
              params.conversationType.trim().toLowerCase() === "channel" && !params.teamAadGroupId
                ? await params.resolveTeamAadGroupId(deadline)
                : params.teamAadGroupId;
            const messageUrl = buildMSTeamsGraphMessageUrl({
              conversationType: params.conversationType,
              conversationId: params.conversationId,
              messageId: activity.id,
              threadRootMessageId: params.conversationMessageId ?? activity.replyToId,
              teamAadGroupId: graphTeamAadGroupId,
              channelId: activity.channelData?.channel?.id,
            });
            if (!messageUrl) {
              params.log.debug?.("graph message url unavailable", {
                conversationType: params.conversationType,
                hasChannelData: Boolean(activity.channelData),
                messageId: activity.id,
                replyToId: activity.replyToId,
              });
            } else {
              const graphMedia = await downloadMSTeamsGraphMedia({
                messageUrl,
                tokenProvider: params.tokenProvider,
                maxBytes: params.mediaMaxBytes,
                allowHosts: params.mediaAllowHosts,
                authAllowHosts: params.mediaAuthAllowHosts,
                deadline,
                logger: params.log,
              });
              mediaList = mergeMSTeamsMediaFacts(mediaList, graphMedia.media, {
                positionallyAligned: false,
              });
              if (!hasMaterializedMedia(mediaList)) {
                params.log.debug?.("graph media fetch empty", {
                  messageUrl,
                  hostedStatus: graphMedia.hostedStatus,
                  attachmentStatus: graphMedia.attachmentStatus,
                  hostedCount: graphMedia.hostedCount,
                  attachmentCount: graphMedia.attachmentCount,
                  tokenError: graphMedia.tokenError,
                  attachmentIdCount: attachmentIds.length,
                });
              }
            }
          }
        }

        const materializedCount = mediaList.filter((media) => Boolean(media.path)).length;
        if (materializedCount > 0) {
          params.log.debug?.("downloaded attachments", { count: materializedCount });
        } else if (params.htmlSummary?.imgTags) {
          params.log.debug?.("inline images detected but none downloaded", {
            imgTags: params.htmlSummary.imgTags,
            srcHosts: params.htmlSummary.srcHosts,
            dataImages: params.htmlSummary.dataImages,
            cidImages: params.htmlSummary.cidImages,
          });
        }
        return mediaList;
      },
    });
  } catch (err) {
    params.log.debug?.("failed to resolve inbound Teams media", {
      error: formatUnknownError(err),
    });
  }

  const inboundMedia = mergeMSTeamsMediaFacts(params.advertisedMedia, resolvedMedia);
  const body = params.rawBody;
  const expectedMediaCount = Math.max(params.advertisedMedia.length, resolvedMedia.length);
  const unavailableCount =
    inboundMedia.filter((media) => !media.path).length +
    Math.max(0, expectedMediaCount - inboundMedia.length);
  const agentBody =
    unavailableCount === 0
      ? body
      : formatInboundMediaUnavailableText({
          body,
          notice: `[msteams ${unavailableCount > 1 ? `${unavailableCount} attachments` : "attachment"} unavailable]`,
        });
  if (!agentBody && inboundMedia.length === 0) {
    params.log.debug?.("skipping empty message after Graph media recovery");
    return null;
  }

  return { agentBody, inboundMedia };
}

function shouldAttemptMSTeamsGraphMediaFallback(params: {
  conversationType: string;
  htmlSummary?: MSTeamsHtmlAttachmentSummary;
  graphMediaFallback?: boolean;
}): boolean {
  const conversationType = params.conversationType.trim().toLowerCase();
  return (
    params.graphMediaFallback === true &&
    (conversationType === "channel" || conversationType === "groupchat") &&
    (params.htmlSummary?.htmlAttachments ?? 0) > 0
  );
}

function hasDefinitiveContentType(media: MSTeamsInboundMedia): boolean {
  const contentType = media.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return Boolean(
    contentType &&
    contentType !== "application/octet-stream" &&
    contentType !== "binary/octet-stream",
  );
}

function mergeMSTeamsMediaFacts(
  nativeMedia: readonly MSTeamsInboundMedia[],
  materializedMedia: readonly MSTeamsInboundMedia[],
  options: { positionallyAligned?: boolean } = {},
): MSTeamsInboundMedia[] {
  // Direct downloads share advertised order; Graph/Bot Framework subsets do not.
  // Fallback results may replace only their matching transport resource identity.
  const merged = [...nativeMedia];
  const nativeSlotCount = nativeMedia.length;
  const nativeIndexBySourceId = new Map<string, number>();
  nativeMedia.forEach((media, index) => {
    if (media.sourceId && !nativeIndexBySourceId.has(media.sourceId)) {
      nativeIndexBySourceId.set(media.sourceId, index);
    }
  });
  for (const [index, materialized] of materializedMedia.entries()) {
    const sourceIndex = materialized.sourceId
      ? nativeIndexBySourceId.get(materialized.sourceId)
      : undefined;
    const positionalIndex =
      options.positionallyAligned === false || index >= nativeMedia.length ? undefined : index;
    const unresolvedIndexes =
      options.positionallyAligned === false
        ? merged
            .slice(0, nativeSlotCount)
            .flatMap((media, mediaIndex) => (!media.path && !media.sourceId ? [mediaIndex] : []))
        : [];
    const fallbackIndex =
      unresolvedIndexes.find((mediaIndex) => merged[mediaIndex]?.kind === materialized.kind) ??
      (unresolvedIndexes.length === 1 ? unresolvedIndexes[0] : undefined);
    const targetIndex = sourceIndex ?? positionalIndex ?? fallbackIndex;
    if (targetIndex === undefined) {
      if (materialized.sourceId) {
        nativeIndexBySourceId.set(materialized.sourceId, merged.length);
      }
      merged.push(materialized);
    } else {
      if (materialized.sourceId) {
        nativeIndexBySourceId.set(materialized.sourceId, targetIndex);
      }
      const current = merged[targetIndex];
      if (materialized.path) {
        merged[targetIndex] = materialized;
      } else if (!current?.path) {
        merged[targetIndex] = {
          ...current,
          ...materialized,
          kind:
            hasDefinitiveContentType(materialized) || !current?.kind
              ? materialized.kind
              : current.kind,
        };
      }
    }
  }
  return merged;
}

function hasMaterializedMedia(media: readonly MSTeamsInboundMedia[]): boolean {
  return media.some((entry) => Boolean(entry.path));
}
