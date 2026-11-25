import { resolveSlackThreadContext } from "../../threading.js";
import type { SlackMessageEvent } from "../../types.js";
import type { SlackMessageChangedEvent, SlackMessageDeletedEvent } from "../types.js";

export function resolveSlackMessageSubtypeHandler(event: SlackMessageEvent) {
  const subtype = event.subtype;
  if (subtype !== "message_changed" && subtype !== "message_deleted") {
    return undefined;
  }
  const changed = event as SlackMessageChangedEvent;
  const message = changed.message?.thread_ts ? changed.message : changed.previous_message;
  const isChanged = subtype === "message_changed";
  const senderId = isChanged
    ? (changed.message?.user ??
      changed.previous_message?.user ??
      changed.message?.bot_id ??
      changed.previous_message?.bot_id)
    : (changed.previous_message?.user ?? changed.previous_message?.bot_id);
  const messageId = isChanged
    ? (changed.message?.ts ?? changed.previous_message?.ts ?? changed.event_ts)
    : ((event as SlackMessageDeletedEvent).deleted_ts ?? event.event_ts);
  return {
    eventKind: subtype,
    describe: (channelLabel: string) =>
      `Slack message ${isChanged ? "edited" : "deleted"} in ${channelLabel}.`,
    contextKey: `slack:message:${isChanged ? "changed" : "deleted"}:${event.channel ?? "unknown"}:${messageId ?? "unknown"}`,
    senderId,
    threadTs: message
      ? resolveSlackThreadContext({
          message: { type: "message", channel: event.channel, ...message },
          replyToMode: "off",
        }).replyToId
      : undefined,
  };
}
