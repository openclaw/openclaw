const DEFAULT_INBOUND_DEBOUNCE_MS = 500;
function combineDebounceEntries(entries) {
  if (entries.length === 0) {
    throw new Error("Cannot combine empty entries");
  }
  if (entries.length === 1) {
    return entries[0].message;
  }
  const first = entries[0].message;
  const seenTexts = /* @__PURE__ */ new Set();
  const textParts = [];
  for (const entry of entries) {
    const text = entry.message.text.trim();
    if (!text) {
      continue;
    }
    const normalizedText = text.toLowerCase();
    if (seenTexts.has(normalizedText)) {
      continue;
    }
    seenTexts.add(normalizedText);
    textParts.push(text);
  }
  const allAttachments = entries.flatMap((e) => e.message.attachments ?? []);
  const timestamps = entries.map((e) => e.message.timestamp).filter((t) => typeof t === "number");
  const latestTimestamp = timestamps.length > 0 ? Math.max(...timestamps) : first.timestamp;
  const messageIds = entries.map((e) => e.message.messageId).filter((id) => Boolean(id));
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
    balloonBundleId: void 0
  };
}
function resolveBlueBubblesDebounceMs(config, core) {
  const inbound = config.messages?.inbound;
  const hasExplicitDebounce = typeof inbound?.debounceMs === "number" || typeof inbound?.byChannel?.bluebubbles === "number";
  if (!hasExplicitDebounce) {
    return DEFAULT_INBOUND_DEBOUNCE_MS;
  }
  return core.channel.debounce.resolveInboundDebounceMs({ cfg: config, channel: "bluebubbles" });
}
function createBlueBubblesDebounceRegistry(params) {
  const targetDebouncers = /* @__PURE__ */ new Map();
  return {
    getOrCreateDebouncer: (target) => {
      const existing = targetDebouncers.get(target);
      if (existing) {
        return existing;
      }
      const { account, config, runtime, core } = target;
      const debouncer = core.channel.debounce.createInboundDebouncer({
        debounceMs: resolveBlueBubblesDebounceMs(config, core),
        buildKey: (entry) => {
          const msg = entry.message;
          const balloonBundleId = msg.balloonBundleId?.trim();
          const associatedMessageGuid = msg.associatedMessageGuid?.trim();
          if (balloonBundleId && associatedMessageGuid) {
            return `bluebubbles:${account.accountId}:balloon:${associatedMessageGuid}`;
          }
          const messageId = msg.messageId?.trim();
          if (messageId) {
            return `bluebubbles:${account.accountId}:msg:${messageId}`;
          }
          const chatKey = msg.chatGuid?.trim() ?? msg.chatIdentifier?.trim() ?? (msg.chatId ? String(msg.chatId) : "dm");
          return `bluebubbles:${account.accountId}:${chatKey}:${msg.senderId}`;
        },
        shouldDebounce: (entry) => {
          const msg = entry.message;
          if (msg.fromMe) {
            return false;
          }
          if (core.channel.text.hasControlCommand(msg.text, config)) {
            return false;
          }
          return true;
        },
        onFlush: async (entries) => {
          if (entries.length === 0) {
            return;
          }
          const flushTarget = entries[0].target;
          if (entries.length === 1) {
            await params.processMessage(entries[0].message, flushTarget);
            return;
          }
          const combined = combineDebounceEntries(entries);
          if (core.logging.shouldLogVerbose()) {
            const count = entries.length;
            const preview = combined.text.slice(0, 50);
            runtime.log?.(
              `[bluebubbles] coalesced ${count} messages: "${preview}${combined.text.length > 50 ? "..." : ""}"`
            );
          }
          await params.processMessage(combined, flushTarget);
        },
        onError: (err) => {
          runtime.error?.(
            `[${account.accountId}] [bluebubbles] debounce flush failed: ${String(err)}`
          );
        }
      });
      targetDebouncers.set(target, debouncer);
      return debouncer;
    },
    removeDebouncer: (target) => {
      targetDebouncers.delete(target);
    }
  };
}
export {
  createBlueBubblesDebounceRegistry
};
