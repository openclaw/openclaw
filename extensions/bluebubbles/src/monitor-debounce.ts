import type { NormalizedWebhookMessage } from "./monitor-normalize.js";
import type { BlueBubblesCoreRuntime, WebhookTarget } from "./monitor-shared.js";
import type { OpenClawConfig } from "./runtime-api.js";

/**
 * Entry type for debouncing inbound messages.
 * Captures the normalized message and its target for later combined processing.
 */
type BlueBubblesDebounceEntry = {
  message: NormalizedWebhookMessage;
  target: WebhookTarget;
  eventType?: string;
  replayLifecycle?: {
    onFlushSuccess: () => void;
    onFlushFailure: (err: unknown) => void;
  };
};

export type BlueBubblesDebouncer = {
  enqueue: (item: BlueBubblesDebounceEntry) => Promise<void>;
  flushKey: (key: string) => Promise<void>;
};

export type BlueBubblesDebounceRegistry = {
  getOrCreateDebouncer: (target: WebhookTarget) => BlueBubblesDebouncer;
  removeDebouncer: (target: WebhookTarget) => void;
};

/**
 * Default debounce window for inbound message coalescing (ms).
 * This helps combine URL text + link preview balloon messages that BlueBubbles
 * sends as separate webhook events when no explicit inbound debounce config exists.
 */
const DEFAULT_INBOUND_DEBOUNCE_MS = 500;

/**
 * Combines multiple debounced messages into a single message for processing.
 * Used when multiple webhook events arrive within the debounce window.
 */
function combineDebounceEntries(entries: BlueBubblesDebounceEntry[]): NormalizedWebhookMessage {
  if (entries.length === 0) {
    throw new Error("Cannot combine empty entries");
  }
  if (entries.length === 1) {
    return entries[0].message;
  }

  // Use the first message as the base (typically the text message)
  const first = entries[0].message;

  // Combine text from all entries, filtering out duplicates and empty strings
  const seenTexts = new Set<string>();
  const textParts: string[] = [];

  for (const entry of entries) {
    const text = entry.message.text.trim();
    if (!text) {
      continue;
    }
    // Skip duplicate text (URL might be in both text message and balloon)
    const normalizedText = text.toLowerCase();
    if (seenTexts.has(normalizedText)) {
      continue;
    }
    seenTexts.add(normalizedText);
    textParts.push(text);
  }

  // Merge attachments from all entries
  const allAttachments = entries.flatMap((e) => e.message.attachments ?? []);

  // Use the latest timestamp
  const timestamps = entries
    .map((e) => e.message.timestamp)
    .filter((t): t is number => typeof t === "number");
  const latestTimestamp = timestamps.length > 0 ? Math.max(...timestamps) : first.timestamp;

  // Collect all message IDs for reference
  const messageIds = entries
    .map((e) => e.message.messageId)
    .filter((id): id is string => Boolean(id));

  // Prefer reply context from any entry that has it
  const entryWithReply = entries.find((e) => e.message.replyToId);

  return {
    ...first,
    text: textParts.join(" "),
    attachments: allAttachments.length > 0 ? allAttachments : first.attachments,
    timestamp: latestTimestamp,
    // Use first message's ID as primary (for reply reference), but we've coalesced others
    messageId: messageIds[0] ?? first.messageId,
    // Preserve reply context if present
    replyToId: entryWithReply?.message.replyToId ?? first.replyToId,
    replyToBody: entryWithReply?.message.replyToBody ?? first.replyToBody,
    replyToSender: entryWithReply?.message.replyToSender ?? first.replyToSender,
    // Clear balloonBundleId since we've combined (the combined message is no longer just a balloon)
    balloonBundleId: undefined,
  };
}

function resolveBlueBubblesDebounceMs(
  config: OpenClawConfig,
  core: BlueBubblesCoreRuntime,
): number {
  const inbound = config.messages?.inbound;
  const hasExplicitDebounce =
    typeof inbound?.debounceMs === "number" || typeof inbound?.byChannel?.bluebubbles === "number";
  if (!hasExplicitDebounce) {
    return DEFAULT_INBOUND_DEBOUNCE_MS;
  }
  return core.channel.debounce.resolveInboundDebounceMs({ cfg: config, channel: "bluebubbles" });
}

function resolveBlueBubblesFallbackChatKey(message: NormalizedWebhookMessage): string {
  return (
    message.chatGuid?.trim() ??
    message.chatIdentifier?.trim() ??
    (message.chatId ? String(message.chatId) : "dm")
  );
}

function resolveBlueBubblesFallbackDebounceKey(
  accountId: string,
  message: NormalizedWebhookMessage,
): string {
  return `bluebubbles:${accountId}:${resolveBlueBubblesFallbackChatKey(message)}:${message.senderId}`;
}

export function createBlueBubblesDebounceRegistry(params: {
  processMessage: (message: NormalizedWebhookMessage, target: WebhookTarget) => Promise<void>;
}): BlueBubblesDebounceRegistry {
  const targetDebouncers = new Map<WebhookTarget, BlueBubblesDebouncer>();
  const stableUpdatedMessageTails = new Map<string, Promise<void>>();
  const resolveStableUpdatedMessageIdentity = (message: NormalizedWebhookMessage) => {
    const messageId = message.messageId?.trim();
    const associatedMessageGuid = message.associatedMessageGuid?.trim();
    const stableIdentity = messageId || associatedMessageGuid;
    if (stableIdentity) {
      return `msg:${stableIdentity}`;
    }
    return undefined;
  };
  const hasStableUpdatedMessageIdentity = (message: NormalizedWebhookMessage): boolean =>
    Boolean(resolveStableUpdatedMessageIdentity(message));
  const serializeStableUpdatedMessage = async (
    serialKey: string,
    task: () => Promise<void>,
  ): Promise<void> => {
    const previous = stableUpdatedMessageTails.get(serialKey) ?? Promise.resolve();
    let releaseCurrentTail: (() => void) | undefined;
    const currentMarker = new Promise<void>((resolve) => {
      releaseCurrentTail = resolve;
    });
    const currentTail = previous.catch(() => undefined).then(() => currentMarker);
    stableUpdatedMessageTails.set(serialKey, currentTail);
    try {
      await previous.catch(() => undefined);
      await task();
    } finally {
      releaseCurrentTail?.();
      if (stableUpdatedMessageTails.get(serialKey) === currentTail) {
        stableUpdatedMessageTails.delete(serialKey);
      }
    }
  };
  const settleReplayLifecycle = (
    entries: BlueBubblesDebounceEntry[],
    result: "success" | "failure",
    err?: unknown,
  ) => {
    for (const entry of entries) {
      const lifecycle = entry.replayLifecycle;
      if (!lifecycle) {
        continue;
      }
      try {
        if (result === "success") {
          lifecycle.onFlushSuccess();
        } else {
          lifecycle.onFlushFailure(err);
        }
      } catch {
        // Keep debounce flush resilient even if replay bookkeeping throws.
      }
    }
  };

  return {
    getOrCreateDebouncer: (target) => {
      const existing = targetDebouncers.get(target);
      if (existing) {
        return existing;
      }

      const { account, config, runtime, core } = target;
      const debouncer = core.channel.debounce.createInboundDebouncer<BlueBubblesDebounceEntry>({
        debounceMs: resolveBlueBubblesDebounceMs(config, core),
        buildKey: (entry) => {
          const msg = entry.message;
          // Prefer stable, shared identifiers to coalesce rapid-fire webhook events for the
          // same message (e.g., text-only then text+attachment).
          //
          // For balloons (URL previews, stickers, etc), BlueBubbles often uses a different
          // messageId than the originating text. When present, key by associatedMessageGuid
          // to keep text + balloon coalescing working.
          const balloonBundleId = msg.balloonBundleId?.trim();
          const associatedMessageGuid = msg.associatedMessageGuid?.trim();
          if (balloonBundleId && associatedMessageGuid) {
            return `bluebubbles:${account.accountId}:balloon:${associatedMessageGuid}`;
          }

          const messageId = msg.messageId?.trim();
          if (messageId) {
            return `bluebubbles:${account.accountId}:msg:${messageId}`;
          }
          const fallbackKey = resolveBlueBubblesFallbackDebounceKey(account.accountId, msg);
          // Separate updated-message events from new-message events in the
          // fallback bucket so guid-less edits don't merge with or reset the
          // timer of the original new-message debounce entry.
          return entry.eventType === "updated-message" ? `${fallbackKey}:edit` : fallbackKey;
        },
        shouldDebounce: (entry) => {
          const msg = entry.message;
          if (entry.eventType === "updated-message") {
            // Only fast-path edits when we can flush the matching identity bucket safely.
            // GUID-less edits are better debounced so they do not flush an unrelated
            // fallback bucket or miss the original pending bucket when BlueBubbles
            // shifts the timestamp between webhook deliveries.
            return !hasStableUpdatedMessageIdentity(msg);
          }
          // Skip debouncing for from-me messages (they're just cached, not processed)
          if (msg.fromMe) {
            return false;
          }
          // Skip debouncing for control commands - process immediately
          if (core.channel.text.hasControlCommand(msg.text, config)) {
            return false;
          }
          // Debounce all other messages to coalesce rapid-fire webhook events
          // (e.g., text+image arriving as separate webhooks for the same messageId)
          return true;
        },
        onFlush: async (entries) => {
          if (entries.length === 0) {
            return;
          }

          // Use target from first entry (all entries have same target due to key structure)
          const flushTarget = entries[0].target;

          if (entries.length === 1) {
            try {
              // Single message - process normally
              await params.processMessage(entries[0].message, flushTarget);
              settleReplayLifecycle(entries, "success");
              return;
            } catch (err) {
              settleReplayLifecycle(entries, "failure", err);
              throw err;
            }
          }

          // Multiple messages - combine and process
          const combined = combineDebounceEntries(entries);

          if (core.logging.shouldLogVerbose()) {
            const count = entries.length;
            const preview = combined.text.slice(0, 50);
            runtime.log?.(
              `[bluebubbles] coalesced ${count} messages: "${preview}${combined.text.length > 50 ? "..." : ""}"`,
            );
          }

          try {
            await params.processMessage(combined, flushTarget);
            settleReplayLifecycle(entries, "success");
          } catch (err) {
            settleReplayLifecycle(entries, "failure", err);
            throw err;
          }
        },
        onError: (err) => {
          runtime.error?.(
            `[${account.accountId}] [bluebubbles] debounce flush failed: ${String(err)}`,
          );
        },
      });

      const wrappedDebouncer: BlueBubblesDebouncer = {
        enqueue: async (entry) => {
          const stableIdentity =
            entry.eventType === "updated-message"
              ? resolveStableUpdatedMessageIdentity(entry.message)
              : undefined;
          const runEnqueue = async () => {
            if (stableIdentity) {
              const messageId = entry.message.messageId?.trim();
              const associatedMessageGuid = entry.message.associatedMessageGuid?.trim();
              if (associatedMessageGuid && !messageId) {
                // Flush both balloon and msg buckets keyed by the assoc GUID
                // so any buffered pre-edit body or preview doesn't fire after
                // the immediate edit dispatch.
                await debouncer.flushKey(
                  `bluebubbles:${account.accountId}:balloon:${associatedMessageGuid}`,
                );
                await debouncer.flushKey(
                  `bluebubbles:${account.accountId}:msg:${associatedMessageGuid}`,
                );
              }
            }
            await debouncer.enqueue(entry);
          };
          if (!stableIdentity) {
            await runEnqueue();
            return;
          }
          await serializeStableUpdatedMessage(
            `bluebubbles:${account.accountId}:${stableIdentity}`,
            runEnqueue,
          );
        },
        flushKey: (key) => debouncer.flushKey(key),
      };
      targetDebouncers.set(target, wrappedDebouncer);
      return wrappedDebouncer;
    },
    removeDebouncer: (target) => {
      targetDebouncers.delete(target);
    },
  };
}
