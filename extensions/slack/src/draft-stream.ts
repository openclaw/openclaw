import type { MessageMetadata } from "@slack/types";
import type { Block, KnownBlock } from "@slack/web-api";
import { createFinalizableDraftLifecycle } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { deleteSlackMessage, editSlackMessage } from "./actions.js";
import { trackSlackDraftMessage } from "./draft-message-boundaries.js";
import { formatSlackError } from "./errors.js";
import { SLACK_TEXT_LIMIT } from "./limits.js";
import type { SlackEventScope } from "./monitor/event-scope.js";
import type { SlackSendIdentity } from "./send.js";
import { sendMessageSlack } from "./send.js";

const DEFAULT_THROTTLE_MS = 1000;

type SlackDraftStreamUpdate =
  | string
  | {
      text: string;
      blocks?: (Block | KnownBlock)[];
      // Partial preambles can edit a visible draft, but must never create a
      // fresh Slack notification after an intervening human reply rotates it.
      allowNewMessage?: boolean;
    };

type SlackDraftMessage = {
  channelId: string;
  messageId: string;
  detachedByHuman?: boolean;
  retained?: boolean;
};

export function createSlackDraftStream(params: {
  target: string;
  cfg: OpenClawConfig;
  token: string;
  accountId?: string;
  conversationChannelId?: string;
  eventScope?: SlackEventScope;
  identity?: SlackSendIdentity;
  maxChars?: number;
  throttleMs?: number;
  resolveThreadTs?: () => string | undefined;
  metadata?: MessageMetadata;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  send?: typeof sendMessageSlack;
  edit?: typeof editSlackMessage;
  remove?: typeof deleteSlackMessage;
}) {
  const maxChars = Math.min(params.maxChars ?? SLACK_TEXT_LIMIT, SLACK_TEXT_LIMIT);
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const send = params.send ?? sendMessageSlack;
  const edit = params.edit ?? editSlackMessage;
  const remove = params.remove ?? deleteSlackMessage;

  let streamMessage: SlackDraftMessage | undefined;
  let untrackConversationBoundary: (() => void) | undefined;
  let lastSentKey = "";
  let preserveHumanReplies = false;
  const streamState = { stopped: false, final: false };

  const normalizeUpdate = (update: SlackDraftStreamUpdate) =>
    typeof update === "string" ? { text: update } : update;
  const clearMessageId = () => {
    streamMessage = undefined;
    lastSentKey = "";
  };
  const editPreview = (message: SlackDraftMessage, text: string, blocks?: (Block | KnownBlock)[]) =>
    edit(message.channelId, message.messageId, text, {
      cfg: params.cfg,
      token: params.token,
      accountId: params.accountId,
      ...(params.eventScope ? { client: params.eventScope.client } : {}),
      ...(blocks ? { blocks } : {}),
    });

  const sendOrEditStreamMessage = async (pending: SlackDraftStreamUpdate) => {
    const update = normalizeUpdate(pending);
    const trimmed = update.text.trimEnd();
    if (!trimmed) {
      return;
    }
    if (!streamMessage && update.allowNewMessage === false) {
      return;
    }
    if (trimmed.length > maxChars) {
      streamState.stopped = true;
      params.warn?.(`slack stream preview stopped (text length ${trimmed.length} > ${maxChars})`);
      return;
    }
    const blocks = update.blocks;
    const sentKey = `${trimmed}\n${blocks ? JSON.stringify(blocks) : ""}`;
    if (sentKey === lastSentKey) {
      return;
    }
    lastSentKey = sentKey;
    try {
      if (streamMessage) {
        await editPreview(streamMessage, trimmed, blocks);
        return;
      }
      const threadTs = params.resolveThreadTs?.();
      const trackMessage = (channelId: string, messageTs?: string) =>
        trackSlackDraftMessage({
          accountId: params.accountId,
          teamId: params.eventScope?.teamId,
          channelId,
          threadTs,
          messageTs,
          onInterveningMessage: () => forceNewMessage("human"),
        });
      await lifecycle.createMessage(
        async () => {
          const sent = await send(params.target, trimmed, {
            cfg: params.cfg,
            token: params.token,
            accountId: params.accountId,
            threadTs,
            identity: params.identity,
            eventScope: params.eventScope,
            ...(params.metadata ? { metadata: params.metadata } : {}),
            ...(blocks ? { blocks } : {}),
          });
          return sent.channelId && sent.messageId
            ? { channelId: sent.channelId, messageId: sent.messageId }
            : undefined;
        },
        (sentMessage) => {
          if (!sentMessage) {
            stopTrackingConversationBoundary();
            streamState.stopped = true;
            params.warn?.("slack stream preview stopped (missing identifiers from sendMessage)");
            return false;
          }
          const { channelId, messageId } = sentMessage;
          streamMessage = sentMessage;
          stopTrackingConversationBoundary();
          untrackConversationBoundary = trackMessage(channelId, messageId).stop;
          return true;
        },
        { defer: true },
      );
    } catch (err) {
      stopTrackingConversationBoundary();
      streamState.stopped = true;
      params.warn?.(`slack stream preview failed: ${formatSlackError(err)}`);
    }
  };
  const lifecycle = createFinalizableDraftLifecycle<SlackDraftMessage, SlackDraftStreamUpdate>({
    throttleMs,
    coalesceInFlight: true,
    state: streamState,
    sendOrEditStreamMessage,
    emptyValue: "",
    isEmpty: (value) => !normalizeUpdate(value).text.trim(),
    readMessageId: () => streamMessage,
    clearMessageId,
    isValidMessageId: (value): value is SlackDraftMessage =>
      typeof value === "object" && value !== null,
    deleteMessage: async (message) => {
      if (!message.retained && !(preserveHumanReplies && message.detachedByHuman)) {
        await remove(message.channelId, message.messageId, {
          token: params.token,
          accountId: params.accountId,
          ...(params.eventScope ? { client: params.eventScope.client } : {}),
        });
      }
      return true;
    },
    warn: params.warn,
    warnPrefix: "slack stream preview cleanup failed",
  });
  const { loop, update, discardPending, seal } = lifecycle;

  const stopTrackingConversationBoundary = () => {
    untrackConversationBoundary?.();
    untrackConversationBoundary = undefined;
  };

  const dropDetachedMessages = () =>
    lifecycle.cleanupPending(() => {
      preserveHumanReplies = false;
    });

  const discardPendingAndStopTracking = async () => {
    await discardPending();
    stopTrackingConversationBoundary();
  };

  const clear = async (options?: { preserveHumanReplies?: boolean }) => {
    // Cleanup is best effort if a caller starts another turn before it finishes.
    await lifecycle.clearWithStop(async () => {
      await discardPendingAndStopTracking();
      preserveHumanReplies = options?.preserveHumanReplies === true;
    });
  };

  const forceNewMessage = (reason: "turn" | "human" = "turn") => {
    stopTrackingConversationBoundary();
    if (streamMessage && !streamMessage.retained) {
      // Slack decides whether human-replied context may be removed; the shared
      // lifecycle retains deletion custody until that decision is made.
      streamMessage.detachedByHuman = reason === "human";
      void lifecycle.retire(streamMessage, { defer: true });
    }
    // Human boundaries change the target without reopening a stream that is
    // closing. Only explicit admission of another turn resumes delivery.
    if (reason === "turn") {
      lifecycle.reset("discard", "keep");
    } else {
      streamState.final = false;
      lifecycle.resetMessage("keep");
    }
  };

  const finalizeMessage = async (
    messageId: string,
    editFinal: () => Promise<void>,
  ): Promise<boolean> => {
    const currentMessage = streamMessage;
    if (!currentMessage || currentMessage.messageId !== messageId) {
      return false;
    }
    await editFinal();
    // An accepted final stays final even if a human replied during the edit.
    currentMessage.retained = true;
    stopTrackingConversationBoundary();
    return true;
  };

  params.log?.(`slack stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update,
    flush: loop.flush,
    clear,
    discardPending: discardPendingAndStopTracking,
    seal,
    forceNewMessage,
    dropDetachedMessages,
    finalizeMessage,
    messageId: () => streamMessage?.messageId,
    channelId: () => streamMessage?.channelId,
  };
}
