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

type SlackDraftStream = {
  update: (update: SlackDraftStreamUpdate) => void;
  flush: () => Promise<void>;
  clear: (options?: { preserveHumanReplies?: boolean }) => Promise<void>;
  discardPending: () => Promise<void>;
  seal: () => Promise<void>;
  forceNewMessage: () => void;
  dropDetachedMessages: () => Promise<void>;
  finalizeMessage: (messageId: string, editFinal: () => Promise<void>) => Promise<boolean>;
  messageId: () => string | undefined;
  channelId: () => string | undefined;
};

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
  generation: number;
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
}): SlackDraftStream {
  const maxChars = Math.min(params.maxChars ?? SLACK_TEXT_LIMIT, SLACK_TEXT_LIMIT);
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const send = params.send ?? sendMessageSlack;
  const edit = params.edit ?? editSlackMessage;
  const remove = params.remove ?? deleteSlackMessage;

  let streamMessage: SlackDraftMessage | undefined;
  let streamGeneration = 0;
  let cleanupGeneration = -1;
  let untrackConversationBoundary: (() => void) | undefined;
  let lastVisibleUpdate: { text: string; blocks?: (Block | KnownBlock)[] } | undefined;
  let lastSentKey = "";
  let preserveHumanReplies = false;
  const streamState = { stopped: false, final: false };

  const normalizeUpdate = (update: SlackDraftStreamUpdate) =>
    typeof update === "string" ? { text: update } : update;

  const sendOrEditStreamMessage = async (pending: SlackDraftStreamUpdate) => {
    if (streamState.stopped) {
      return;
    }
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
    const generation = streamGeneration;
    try {
      if (streamMessage) {
        const message = streamMessage;
        await edit(streamMessage.channelId, streamMessage.messageId, trimmed, {
          cfg: params.cfg,
          token: params.token,
          accountId: params.accountId,
          ...(params.eventScope ? { client: params.eventScope.client } : {}),
          ...(blocks ? { blocks } : {}),
        });
        if (streamMessage === message) {
          lastVisibleUpdate = { text: trimmed, ...(blocks ? { blocks } : {}) };
        }
        return;
      }
      const threadTs = params.resolveThreadTs?.();
      const pendingBoundary = params.conversationChannelId
        ? trackSlackDraftMessage({
            accountId: params.accountId,
            teamId: params.eventScope?.teamId,
            channelId: params.conversationChannelId,
            threadTs,
            onInterveningMessage: () => forceNewMessage("human"),
          })
        : undefined;
      untrackConversationBoundary = pendingBoundary?.stop;
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
      const sentMessage = { channelId: sent.channelId, messageId: sent.messageId, generation };
      if (generation !== streamGeneration) {
        if (sent.channelId && sent.messageId) {
          void lifecycle.retire(sentMessage, { defer: true });
        }
        return;
      }
      if (!sent.channelId || !sent.messageId) {
        stopTrackingConversationBoundary();
        streamState.stopped = true;
        params.warn?.("slack stream preview stopped (missing identifiers from sendMessage)");
        return;
      }
      streamMessage = sentMessage;
      lastVisibleUpdate = { text: trimmed, ...(blocks ? { blocks } : {}) };
      if (pendingBoundary && params.conversationChannelId === streamMessage.channelId) {
        pendingBoundary.setMessageTs(streamMessage.messageId);
      } else {
        stopTrackingConversationBoundary();
        const tracker = trackSlackDraftMessage({
          accountId: params.accountId,
          teamId: params.eventScope?.teamId,
          channelId: streamMessage.channelId,
          threadTs,
          messageTs: streamMessage.messageId,
          onInterveningMessage: () => forceNewMessage("human"),
        });
        untrackConversationBoundary = tracker.stop;
      }
    } catch (err) {
      if (generation === streamGeneration) {
        stopTrackingConversationBoundary();
        streamState.stopped = true;
      }
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
    clearMessageId: () => {
      streamMessage = undefined;
      lastVisibleUpdate = undefined;
      lastSentKey = "";
    },
    isValidMessageId: (value): value is SlackDraftMessage =>
      typeof value === "object" && value !== null,
    deleteMessage: async (message) => {
      if (message.generation > cleanupGeneration) {
        return false;
      }
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

  const dropDetachedMessages = () => {
    const generation = streamGeneration;
    return lifecycle.cleanupPending(() => {
      preserveHumanReplies = false;
      cleanupGeneration = generation;
    });
  };

  const discardPendingAndStopTracking = async () => {
    // A human can reply before Slack returns the pending preview's identity.
    // Reconcile that receipt before removing the conversation boundary tracker.
    const generation = streamGeneration;
    await discardPending();
    if (generation === streamGeneration) {
      stopTrackingConversationBoundary();
    }
  };

  const clear = async (options?: { preserveHumanReplies?: boolean }) => {
    // Final delivery preserves human-replied context, while failed active
    // deletions and explicit rotations remain eligible for cleanup.
    const generation = streamGeneration;
    let clearingMessage = streamMessage;
    await lifecycle.clearWithStop(
      async () => {
        if (generation === streamGeneration) {
          await discardPendingAndStopTracking();
          if (generation === streamGeneration) {
            clearingMessage = streamMessage;
            streamMessage = undefined;
            lastVisibleUpdate = undefined;
            lastSentKey = "";
          }
        }
        cleanupGeneration = generation;
        preserveHumanReplies = options?.preserveHumanReplies === true;
      },
      {
        readMessageId: () => clearingMessage,
        clearMessageId: () => {
          clearingMessage = undefined;
        },
      },
    );
  };

  const forceNewMessage = (reason: "turn" | "human" = "turn") => {
    stopTrackingConversationBoundary();
    // Human boundaries change the target without reopening a stream that is
    // closing. Only explicit admission of another turn resumes delivery.
    if (reason === "turn") {
      streamState.stopped = false;
      streamGeneration += 1;
    }
    streamState.final = false;
    if (streamMessage && !streamMessage.retained) {
      // Slack decides whether human-replied context may be removed; the shared
      // lifecycle retains deletion custody until that decision is made.
      streamMessage.detachedByHuman = reason === "human";
      void lifecycle.retire(streamMessage, { defer: true });
    }
    streamMessage = undefined;
    lastVisibleUpdate = undefined;
    lastSentKey = "";
    loop.resetPending();
  };

  const finalizeMessage = async (
    messageId: string,
    editFinal: () => Promise<void>,
  ): Promise<boolean> => {
    const currentMessage = streamMessage;
    const previousUpdate = lastVisibleUpdate;
    if (!currentMessage || currentMessage.messageId !== messageId || !previousUpdate) {
      return false;
    }
    const { channelId } = currentMessage;

    await editFinal();
    if (streamMessage?.channelId === channelId && streamMessage.messageId === messageId) {
      currentMessage.retained = true;
      stopTrackingConversationBoundary();
      return true;
    }

    // A human spoke while the final edit was in flight. Preserve the earlier
    // progress they responded to and let the final answer land below them.
    try {
      await edit(channelId, messageId, previousUpdate.text, {
        cfg: params.cfg,
        token: params.token,
        accountId: params.accountId,
        ...(params.eventScope ? { client: params.eventScope.client } : {}),
        ...(previousUpdate.blocks ? { blocks: previousUpdate.blocks } : {}),
      });
    } catch (err) {
      params.warn?.(`slack stream preview restore failed: ${formatSlackError(err)}`);
    }
    return false;
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
