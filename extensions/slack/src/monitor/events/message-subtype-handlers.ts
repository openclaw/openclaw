import { resolveSlackThreadContext } from "../../threading.js";
import type { SlackMessageEvent } from "../../types.js";
import type { SlackMessageChangedEvent, SlackMessageDeletedEvent } from "../types.js";

export function resolveSlackMessageSubtypeHandler(event: SlackMessageEvent) {
  const subtype = event.subtype;
  if (subtype !== "message_changed" && subtype !== "message_deleted") {
    return undefined;
  }
  const changed = event as SlackMessageChangedEvent;
  const isChanged = subtype === "message_changed";
  const message = changed.message?.thread_ts ? changed.message : changed.previous_message;
  // The edit's current content is the new message, including top-level edits
  // without `thread_ts`. A thread-root deletion arrives as a Slackbot tombstone
  // `message_changed`, so its authorship and content stay on the previous message.
  const isTombstone = isChanged && changed.message?.subtype === "tombstone";
  const contentMessage =
    isChanged && !isTombstone
      ? (changed.message ?? changed.previous_message)
      : changed.previous_message;
  const senderId = isChanged
    ? (changed.message?.user ??
      changed.previous_message?.user ??
      changed.message?.bot_id ??
      changed.previous_message?.bot_id)
    : (changed.previous_message?.user ?? changed.previous_message?.bot_id);
  const messageId = isChanged
    ? (changed.message?.ts ?? changed.previous_message?.ts ?? changed.event_ts)
    : ((event as SlackMessageDeletedEvent).deleted_ts ?? event.event_ts);
  const botAuthored = Boolean(contentMessage?.bot_id) || contentMessage?.subtype === "bot_message";
  return {
    eventKind: subtype,
    describe: (channelLabel: string) =>
      `Slack message ${isChanged ? "edited" : "deleted"} in ${channelLabel}.`,
    contextKey: `slack:message:${isChanged ? "changed" : "deleted"}:${event.channel ?? "unknown"}:${messageId ?? "unknown"}`,
    senderId,
    botAuthored,
    text: contentMessage?.text,
    threadTs: message
      ? resolveSlackThreadContext({
          message: { type: "message", channel: event.channel, ...message },
          replyToMode: "off",
        }).replyToId
      : undefined,
  };
}
