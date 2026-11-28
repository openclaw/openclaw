import {
  formatInboundEnvelope,
  type ChannelInboundMediaInput,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveChannelGroups } from "openclaw/plugin-sdk/channel-policy";
import { isControlCommandMessage } from "openclaw/plugin-sdk/command-detection";
import {
  resolveChannelContextVisibilityMode,
  shouldIncludeSupplementalContext,
} from "openclaw/plugin-sdk/context-visibility-runtime";
import { kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import { createChannelHistoryWindow } from "openclaw/plugin-sdk/reply-history";
import type { SignalAccountConfig } from "../account-types.js";
import { isSignalSenderAllowed, type SignalSender } from "../identity.js";
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

function isSameSignalSender(left: SignalSender, right: SignalSender): boolean {
  const leftUuid = left.kind === "uuid" ? left.raw : left.aliases?.uuid;
  const rightUuid = right.kind === "uuid" ? right.raw : right.aliases?.uuid;
  if (leftUuid && rightUuid) {
    return leftUuid.toLowerCase() === rightUuid.toLowerCase();
  }
  return left.kind === "phone" && right.kind === "phone" && left.e164 === right.e164;
}

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
    formatEntry: (historyEntry) =>
      formatInboundEnvelope({
        channel: "Signal",
        from: fromLabel,
        timestamp: historyEntry.timestamp,
        body: `${[historyEntry.body, formatSignalMediaText(historyEntry.media ?? [])]
          .filter(Boolean)
          .join("\n")}${historyEntry.messageId ? ` [id:${historyEntry.messageId}]` : ""}`,
        chatType: "group",
        senderLabel: historyEntry.sender,
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
  // The generic group map describes shared policy fields. This is a Signal-only setting.
  const groups: SignalAccountConfig["groups"] = resolveChannelGroups(
    turn.cfg,
    "signal",
    deps.accountId,
  );
  const includeOtherMembers =
    groupId !== "*" && groups?.[groupId]?.includeOtherMembersHistoryImages === true;
  const candidates = entries.flatMap((entry) => {
    const source = entry.imageSource;
    if (!source || entry.timestamp === undefined || entry.timestamp > timestamp) {
      return [];
    }
    const quoted =
      turn.historyImageQuotes?.some(
        (quote) =>
          quote.messageId === entry.messageId && isSameSignalSender(source.sender, quote.sender),
      ) === true;
    if (
      (!quoted &&
        (timestamp - entry.timestamp > HISTORY_IMAGE_MAX_AGE_MS ||
          (!includeOtherMembers && !isSameSignalSender(source.sender, turn.sender)))) ||
      !shouldIncludeSupplementalContext({
        mode,
        kind: quoted ? "quote" : "history",
        senderAllowed:
          effectiveGroupAllow.length === 0 ||
          isSignalSenderAllowed(source.sender, effectiveGroupAllow),
      })
    ) {
      return [];
    }
    return source.attachments.map((attachment) => ({
      attachment,
      messageId: entry.messageId,
      quoted,
    }));
  });
  // Reserve space for the explicit reply target before taking the newest ambient photos.
  candidates.sort((left, right) => Number(left.quoted) - Number(right.quoted));
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
  const adminDelete = message?.adminDelete;
  const remoteDelete = message?.remoteDelete;
  const target = adminDelete ?? remoteDelete;
  // signal-cli 0.14.8 reports the deleted message ID as remoteDelete.timestamp.
  const timestamp =
    target?.targetTimestamp ??
    target?.targetSentTimestamp ??
    (adminDelete ? undefined : remoteDelete?.timestamp);
  if (typeof timestamp !== "number") {
    return;
  }
  for (const entry of entries ?? []) {
    if (
      entry.messageId === String(timestamp) &&
      entry.imageSource &&
      (adminDelete || isSameSignalSender(entry.imageSource.sender, sender))
    ) {
      delete entry.imageSource;
    }
  }
}
