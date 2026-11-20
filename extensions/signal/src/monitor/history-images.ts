import {
  formatInboundEnvelope,
  type ChannelInboundMediaInput,
} from "openclaw/plugin-sdk/channel-inbound";
import { isControlCommandMessage } from "openclaw/plugin-sdk/command-detection";
import {
  resolveChannelContextVisibilityMode,
  shouldIncludeSupplementalContext,
} from "openclaw/plugin-sdk/context-visibility-runtime";
import { kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import { createChannelHistoryWindow } from "openclaw/plugin-sdk/reply-history";
import { formatSignalSenderId, isSignalSenderAllowed, type SignalSender } from "../identity.js";
import { formatSignalMediaText } from "../media-text.js";
import type { SignalInboundEntry } from "./event-handler.control-lane.js";
import type {
  SignalDataMessage,
  SignalEventHandlerDeps,
  SignalHistoryEntry,
} from "./event-handler.types.js";

// Bound fetches as well as model inputs, matching the shared recent-history image budget.
const MAX_HISTORY_IMAGES = 4;
const HISTORY_IMAGE_MAX_AGE_MS = 30 * 60_000;

export async function resolveSignalGroupHistoryContext(params: {
  deps: SignalEventHandlerDeps;
  entry: SignalInboundEntry;
  groupId: string;
  currentMessage: string;
  fromLabel: string;
  envelopeOptions: Parameters<typeof formatInboundEnvelope>[0]["envelope"];
}) {
  const { deps, entry, groupId, fromLabel, envelopeOptions } = params;
  const history = createChannelHistoryWindow({ historyMap: deps.groupHistories });
  const body = history.buildPendingContext({
    historyKey: groupId,
    limit: deps.historyLimit,
    currentMessage: params.currentMessage,
    formatEntry: (entry) =>
      formatInboundEnvelope({
        channel: "Signal",
        from: fromLabel,
        timestamp: entry.timestamp,
        body: `${[entry.body, formatSignalMediaText(entry.media ?? [])]
          .filter(Boolean)
          .join("\n")}${entry.messageId ? ` [id:${entry.messageId}]` : ""}`,
        chatType: "group",
        senderLabel: entry.sender,
        envelope: envelopeOptions,
      }),
  });
  const inboundHistory = history.buildInboundHistory({
    historyKey: groupId,
    limit: deps.historyLimit,
  });
  // Pass images through current-turn media so embedded and ACP runtimes both receive them.
  const images = await fetchSignalHistoryImages(deps, entry, groupId);
  return { body, inboundHistory, media: [...(entry.media ?? []), ...images] };
}

async function fetchSignalHistoryImages(
  deps: SignalEventHandlerDeps,
  turn: SignalInboundEntry,
  groupId: string,
): Promise<ChannelInboundMediaInput[]> {
  if (
    !turn.wasMentioned ||
    isControlCommandMessage(turn.commandBody, turn.cfg) ||
    deps.ignoreAttachments ||
    deps.historyLimit <= 0
  ) {
    return [];
  }
  const entries = deps.groupHistories.get(groupId)?.slice(-deps.historyLimit) ?? [];
  const timestamp = turn.timestamp ?? Date.now();
  const effectiveGroupAllow =
    turn.channelIngress?.at(-1)?.senderAccess.effectiveGroupAllowFrom ?? [];
  const mode = resolveChannelContextVisibilityMode({
    cfg: turn.cfg,
    channel: "signal",
    accountId: deps.accountId,
  });
  const candidates = entries.flatMap((entry) => {
    const source = entry.imageSource;
    if (
      !source ||
      entry.timestamp === undefined ||
      entry.timestamp > timestamp ||
      timestamp - entry.timestamp > HISTORY_IMAGE_MAX_AGE_MS ||
      !shouldIncludeSupplementalContext({
        mode,
        kind: "history",
        senderAllowed:
          effectiveGroupAllow.length === 0 ||
          isSignalSenderAllowed(source.sender, effectiveGroupAllow),
      })
    ) {
      return [];
    }
    return source.attachments.map((attachment) => ({ attachment, messageId: entry.messageId }));
  });
  const fetchedImages = await Promise.all(
    candidates.slice(-MAX_HISTORY_IMAGES).map(async ({ attachment, messageId }) => {
      try {
        const fetched = await deps.fetchAttachment({
          baseUrl: deps.baseUrl,
          account: deps.account,
          groupId,
          attachment,
          maxBytes: deps.mediaMaxBytes,
        });
        const contentType = fetched?.contentType ?? attachment.contentType;
        return fetched && contentType && kindFromMime(contentType) === "image"
          ? { kind: "image" as const, path: fetched.path, contentType, messageId }
          : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return fetchedImages.filter((image) => image !== undefined);
}

export function rememberSignalHistoryImages(
  sender: SignalSender,
  message: SignalDataMessage,
  maxBytes: number,
): SignalHistoryEntry["imageSource"] {
  if (message.viewOnce || (message.expiresInSeconds ?? 0) > 0) {
    return undefined;
  }
  const images = (message.attachments ?? []).filter(
    (attachment) =>
      attachment?.id &&
      kindFromMime(attachment.contentType ?? undefined) === "image" &&
      (attachment.size == null || attachment.size <= maxBytes),
  );
  return images.length ? { sender, attachments: images.slice(-MAX_HISTORY_IMAGES) } : undefined;
}

export function forgetSignalHistoryImages(
  entries: SignalHistoryEntry[] | undefined,
  sender: SignalSender,
  message?: SignalDataMessage | null,
) {
  const target = message?.adminDelete ?? message?.remoteDelete;
  const timestamp = target?.targetTimestamp ?? target?.targetSentTimestamp;
  if (typeof timestamp !== "number") {
    return;
  }
  const senderId = message?.adminDelete ? undefined : formatSignalSenderId(sender);
  for (const entry of entries ?? []) {
    if (
      entry.messageId === String(timestamp) &&
      entry.imageSource &&
      (!senderId || isSignalSenderAllowed(entry.imageSource.sender, [senderId]))
    ) {
      delete entry.imageSource;
    }
  }
}
