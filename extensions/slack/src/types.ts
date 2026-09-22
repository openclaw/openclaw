// Slack type declarations define plugin contracts.
import type { AppMentionEvent, GenericMessageEvent, MessageAttachment } from "@slack/types";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SlackAppContext } from "./agent-context.js";

type SlackFileSource = NonNullable<GenericMessageEvent["files"]>[number];
type SlackFileField = "id" | "mimetype" | "size" | "url_private" | "url_private_download";
export type SlackFile = Partial<Pick<SlackFileSource, SlackFileField>> & {
  name?: Exclude<SlackFileSource["name"], null>;
  subtype?: string;
};

export type SlackAttachment = Partial<MessageAttachment> & {
  author_id?: string;
  from_url?: string;
  channel_name?: string;
  channel_id?: string;
  is_msg_unfurl?: boolean;
  is_share?: boolean;
  image_width?: number;
  image_height?: number;
  files?: SlackFile[];
  message_blocks?: unknown[];
};

type SlackMessageBase = Omit<
  Partial<GenericMessageEvent>,
  "type" | "channel" | "channel_type" | "subtype" | "files" | "attachments" | "app_context"
> &
  Pick<GenericMessageEvent, "type" | "channel">;

export interface SlackMessageEvent extends SlackMessageBase {
  channel_type?: "im" | "mpim" | "channel" | "group";
  subtype?: string;
  username?: string;
  files?: SlackFile[];
  attachments?: SlackAttachment[];
  app_context?: SlackAppContext;
  /** Set when Slack supplied parent_user_id but the parent thread timestamp was unavailable. */
  _ambiguousThreadReply?: boolean;
}

export function parseSlackMessageEvent(value: unknown): SlackMessageEvent | undefined {
  const record = asOptionalRecord(value);
  return record?.type === "message" && typeof record.channel === "string"
    ? { ...record, type: "message", channel: record.channel }
    : undefined;
}

export function requireSlackMessageEvent(value: unknown): SlackMessageEvent {
  const event = parseSlackMessageEvent(value);
  if (!event) {
    throw new TypeError("Invalid persisted Slack message event");
  }
  return event;
}

type SlackAppMentionBase = Omit<
  Partial<AppMentionEvent>,
  "type" | "channel" | "text" | "attachments"
> &
  Pick<AppMentionEvent, "type" | "channel">;

export type SlackAppMentionEvent = SlackAppMentionBase & {
  text?: string;
  parent_user_id?: string;
  channel_type?: "im" | "mpim" | "channel" | "group";
  attachments?: SlackAttachment[];
};
