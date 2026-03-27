import {
  createChannelInboundDebouncer,
  isAbortTrigger,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import type { ResolvedSlackAccount } from "../accounts.js";
import type { SlackMessageEvent } from "../types.js";
import { stripSlackMentionsForCommandDetection } from "./commands.js";
import type { SlackMonitorContext } from "./context.js";
import { dispatchPreparedSlackMessage } from "./message-handler/dispatch.js";
import { prepareSlackMessage } from "./message-handler/prepare.js";
import { createSlackThreadTsResolver } from "./thread-resolution.js";

export type SlackMessageHandler = (
  message: SlackMessageEvent,
  opts: { source: "message" | "app_mention"; wasMentioned?: boolean },
) => Promise<void>;

const APP_MENTION_RETRY_TTL_MS = 60_000;

function resolveSlackSenderId(message: SlackMessageEvent): string | null {
  return message.user ?? message.bot_id ?? null;
}

function isSlackDirectMessageChannel(channelId: string): boolean {
  return channelId.startsWith("D");
}

function isTopLevelSlackMessage(message: SlackMessageEvent): boolean {
  return !message.thread_ts && !message.parent_user_id;
}

function buildTopLevelSlackConversationKey(
  message: SlackMessageEvent,
  accountId: string,
): string | null {
  if (!isTopLevelSlackMessage(message)) {
    return null;
  }
  const senderId = resolveSlackSenderId(message);
  if (!senderId) {
    return null;
  }
  return `slack:${accountId}:${message.channel}:${senderId}`;
}

function shouldDebounceSlackMessage(message: SlackMessageEvent, cfg: SlackMonitorContext["cfg"]) {
  const text = message.text ?? "";
  const textForCommandDetection = stripSlackMentionsForCommandDetection(text);
  return shouldDebounceTextInbound({
    text: textForCommandDetection,
    cfg,
    hasMedia: Boolean(message.files && message.files.length > 0),
  });
}

function buildSeenMessageKey(channelId: string | undefined, ts: string | undefined): string | null {
  if (!channelId || !ts) {
    return null;
  }
  return `${channelId}:${ts}`;
}

/**
 * Build a debounce key that isolates messages by thread (or by message timestamp
 * for top-level non-DM channel messages). Without per-message scoping, concurrent
 * top-level messages from the same sender can share a key and get merged
 * into a single reply on the wrong thread.
 *
 * DMs intentionally stay channel-scoped to preserve short-message batching.
 */
export function buildSlackDebounceKey(
  message: SlackMessageEvent,
  accountId: string,
): string | null {
  const senderId = resolveSlackSenderId(message);
  if (!senderId) {
    return null;
  }
  const messageTs = message.ts ?? message.event_ts;
  const threadKey = message.thread_ts
    ? `${message.channel}:${message.thread_ts}`
    : message.parent_user_id && messageTs
      ? `${message.channel}:maybe-thread:${messageTs}`
      : messageTs && !isSlackDirectMessageChannel(message.channel)
        ? `${message.channel}:${messageTs}`
        : message.channel;
  return `slack:${accountId}:${threadKey}:${senderId}`;
}

export function createSlackMessageHandler(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  /** Called on each inbound event to update liveness tracking. */
  trackEvent?: () => void;
}): SlackMessageHandler {
  const { ctx, account, trackEvent } = params;
  const { debounceMs, debouncer } = createChannelInboundDebouncer<{
    message: SlackMessageEvent;
    opts: { source: "message" | "app_mention"; wasMentioned?: boolean };
  }>({
    cfg: ctx.cfg,
    channel: "slack",
    buildKey: (entry) => buildSlackDebounceKey(entry.message, ctx.accountId),
    shouldDebounce: (entry) => shouldDebounceSlackMessage(entry.message, ctx.cfg),
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      console.error(
        `[slack-trace] debounce flush entries=${entries.length} source=${last.opts.source} channel=${last.message.channel} ts=${last.message.ts ?? "-"}`,
      );
      const flushedKey = buildSlackDebounceKey(last.message, ctx.accountId);
      const topLevelConversationKey = buildTopLevelSlackConversationKey(
        last.message,
        ctx.accountId,
      );
      if (flushedKey && topLevelConversationKey) {
        const pendingKeys = pendingTopLevelDebounceKeys.get(topLevelConversationKey);
        if (pendingKeys) {
          pendingKeys.delete(flushedKey);
          if (pendingKeys.size === 0) {
            pendingTopLevelDebounceKeys.delete(topLevelConversationKey);
          }
        }
      }
      const combinedText =
        entries.length === 1
          ? (last.message.text ?? "")
          : entries
              .map((entry) => entry.message.text ?? "")
              .filter(Boolean)
              .join("\n");
      const combinedMentioned = entries.some((entry) => Boolean(entry.opts.wasMentioned));
      const syntheticMessage: SlackMessageEvent = {
        ...last.message,
        text: combinedText,
      };
      const prepared = await prepareSlackMessage({
        ctx,
        account,
        message: syntheticMessage,
        opts: {
          ...last.opts,
          wasMentioned: combinedMentioned || last.opts.wasMentioned,
        },
      });
      const seenMessageKey = buildSeenMessageKey(last.message.channel, last.message.ts);
      if (!prepared) {
        console.error(
          `[slack-trace] debounce flush drop reason=prepare-null source=${last.opts.source} channel=${last.message.channel} ts=${last.message.ts ?? "-"}`,
        );
        return;
      }
      if (seenMessageKey) {
        pruneAppMentionRetryKeys(Date.now());
        if (last.opts.source === "app_mention") {
          // If app_mention wins the race and dispatches first, drop the later message dispatch.
          appMentionDispatchedKeys.set(seenMessageKey, Date.now() + APP_MENTION_RETRY_TTL_MS);
        } else if (last.opts.source === "message" && appMentionDispatchedKeys.has(seenMessageKey)) {
          appMentionDispatchedKeys.delete(seenMessageKey);
          appMentionRetryKeys.delete(seenMessageKey);
          console.error(
            `[slack-trace] debounce flush drop reason=message-suppressed-after-app-mention key=${seenMessageKey}`,
          );
          return;
        }
        appMentionRetryKeys.delete(seenMessageKey);
      }
      if (entries.length > 1) {
        const ids = entries.map((entry) => entry.message.ts).filter(Boolean) as string[];
        if (ids.length > 0) {
          prepared.ctxPayload.MessageSids = ids;
          prepared.ctxPayload.MessageSidFirst = ids[0];
          prepared.ctxPayload.MessageSidLast = ids[ids.length - 1];
        }
      }
      console.error(
        `[slack-trace] debounce flush dispatch source=${last.opts.source} channel=${last.message.channel} ts=${last.message.ts ?? "-"}`,
      );
      await dispatchPreparedSlackMessage(prepared);
    },
    onError: (err) => {
      ctx.runtime.error?.(`slack inbound debounce flush failed: ${String(err)}`);
    },
  });
  const threadTsResolver = createSlackThreadTsResolver({ client: ctx.app.client });
  const pendingTopLevelDebounceKeys = new Map<string, Set<string>>();
  const appMentionRetryKeys = new Map<string, number>();
  const appMentionDispatchedKeys = new Map<string, number>();

  const pruneAppMentionRetryKeys = (now: number) => {
    for (const [key, expiresAt] of appMentionRetryKeys) {
      if (expiresAt <= now) {
        appMentionRetryKeys.delete(key);
      }
    }
    for (const [key, expiresAt] of appMentionDispatchedKeys) {
      if (expiresAt <= now) {
        appMentionDispatchedKeys.delete(key);
      }
    }
  };

  const rememberAppMentionRetryKey = (key: string) => {
    const now = Date.now();
    pruneAppMentionRetryKeys(now);
    appMentionRetryKeys.set(key, now + APP_MENTION_RETRY_TTL_MS);
  };

  const consumeAppMentionRetryKey = (key: string) => {
    const now = Date.now();
    pruneAppMentionRetryKeys(now);
    if (!appMentionRetryKeys.has(key)) {
      return false;
    }
    appMentionRetryKeys.delete(key);
    return true;
  };

  return async (message, opts) => {
    console.error(
      `[slack-trace] handler enter source=${opts.source} channel=${message.channel} ts=${message.ts ?? "-"} thread_ts=${message.thread_ts ?? "-"} subtype=${message.subtype ?? "-"} wasMentionedOpt=${Boolean(opts.wasMentioned)} text=${JSON.stringify(message.text ?? "")}`,
    );
    if (opts.source === "message" && message.type !== "message") {
      console.error(
        `[slack-trace] handler drop source=${opts.source} reason=non-message-type type=${message.type ?? "-"} channel=${message.channel} ts=${message.ts ?? "-"}`,
      );
      return;
    }
    if (
      opts.source === "message" &&
      message.subtype &&
      message.subtype !== "file_share" &&
      message.subtype !== "bot_message"
    ) {
      console.error(
        `[slack-trace] handler drop source=${opts.source} reason=unsupported-subtype subtype=${message.subtype} channel=${message.channel} ts=${message.ts ?? "-"}`,
      );
      return;
    }
    const seenMessageKey = buildSeenMessageKey(message.channel, message.ts);
    const wasSeen = seenMessageKey ? ctx.markMessageSeen(message.channel, message.ts) : false;
    console.error(
      `[slack-trace] handler seen-check source=${opts.source} key=${seenMessageKey ?? "-"} wasSeen=${wasSeen}`,
    );
    if (seenMessageKey && opts.source === "message" && !wasSeen) {
      // Prime exactly one fallback app_mention allowance immediately so a near-simultaneous
      // app_mention is not dropped while message handling is still in-flight.
      rememberAppMentionRetryKey(seenMessageKey);
      console.error(`[slack-trace] handler prime-app-mention-retry key=${seenMessageKey}`);
    }
    if (seenMessageKey && wasSeen) {
      // Allow exactly one app_mention retry if the same ts was previously dropped
      // from the message stream before it reached dispatch.
      if (opts.source !== "app_mention" || !consumeAppMentionRetryKey(seenMessageKey)) {
        console.error(
          `[slack-trace] handler drop source=${opts.source} reason=duplicate-seen key=${seenMessageKey}`,
        );
        return;
      }
      console.error(
        `[slack-trace] handler allow source=${opts.source} reason=consume-app-mention-retry key=${seenMessageKey}`,
      );
    }
    trackEvent?.();
    const resolvedMessage = await threadTsResolver.resolve({ message, source: opts.source });
    console.error(
      `[slack-trace] handler resolved source=${opts.source} channel=${resolvedMessage.channel} ts=${resolvedMessage.ts ?? "-"} thread_ts=${resolvedMessage.thread_ts ?? "-"} parent_user_id=${resolvedMessage.parent_user_id ?? "-"}`,
    );
    const debounceKey = buildSlackDebounceKey(resolvedMessage, ctx.accountId);
    const conversationKey = buildTopLevelSlackConversationKey(resolvedMessage, ctx.accountId);
    const canDebounce = debounceMs > 0 && shouldDebounceSlackMessage(resolvedMessage, ctx.cfg);
    console.error(
      `[slack-trace] handler debounce source=${opts.source} canDebounce=${canDebounce} debounceKey=${debounceKey ?? "-"} conversationKey=${conversationKey ?? "-"} debounceMs=${debounceMs}`,
    );
    if (!canDebounce && conversationKey) {
      const pendingKeys = pendingTopLevelDebounceKeys.get(conversationKey);
      if (pendingKeys && pendingKeys.size > 0) {
        console.error(
          `[slack-trace] handler flush-pending conversationKey=${conversationKey} count=${pendingKeys.size}`,
        );
        const keysToFlush = Array.from(pendingKeys);
        for (const pendingKey of keysToFlush) {
          await debouncer.flushKey(pendingKey);
        }
      }
    }
    if (canDebounce && debounceKey && conversationKey) {
      const pendingKeys = pendingTopLevelDebounceKeys.get(conversationKey) ?? new Set<string>();
      pendingKeys.add(debounceKey);
      pendingTopLevelDebounceKeys.set(conversationKey, pendingKeys);
      console.error(
        `[slack-trace] handler remember-pending conversationKey=${conversationKey} debounceKey=${debounceKey} total=${pendingKeys.size}`,
      );
    }
    // EMERGENCY BYPASS: Abort triggers skip the debouncer entirely to avoid
    // being serialized behind active LLM turns via keyChains. The debouncer's
    // enqueue() awaits runFlush which blocks behind any pending chain tasks.
    if (!canDebounce) {
      const textForAbortCheck = stripSlackMentionsForCommandDetection(resolvedMessage.text ?? "");
      if (isAbortTrigger(textForAbortCheck)) {
        console.error(
          `[slack-trace] handler abort-bypass source=${opts.source} channel=${resolvedMessage.channel} ts=${resolvedMessage.ts ?? "-"}`,
        );
        const prepared = await prepareSlackMessage({
          ctx,
          account,
          message: resolvedMessage,
          opts,
        });
        if (prepared) {
          await dispatchPreparedSlackMessage(prepared);
        }
        console.error(
          `[slack-trace] handler abort-bypass-done source=${opts.source} channel=${resolvedMessage.channel} ts=${resolvedMessage.ts ?? "-"}`,
        );
        return;
      }
    }
    await debouncer.enqueue({ message: resolvedMessage, opts });
    console.error(
      `[slack-trace] handler enqueued source=${opts.source} channel=${resolvedMessage.channel} ts=${resolvedMessage.ts ?? "-"} debounceKey=${debounceKey ?? "-"}`,
    );
  };
}
