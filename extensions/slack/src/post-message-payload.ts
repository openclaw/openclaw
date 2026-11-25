import type { MessageMetadata } from "@slack/types";
import type { Block, ChatPostMessageArguments, KnownBlock } from "@slack/web-api";

export type SlackUnfurlOptions = {
  unfurlLinks?: boolean;
  unfurlMedia?: boolean;
};

export type SlackBasePostMessagePayload = (
  | {
      thread_ts: string;
      reply_broadcast: true;
    }
  | {
      thread_ts?: string;
      reply_broadcast?: never;
    }
) & {
  channel: string;
  text: string;
  blocks?: (Block | KnownBlock)[];
  metadata?: MessageMetadata;
  mrkdwn?: boolean;
  unfurl_links?: boolean;
  unfurl_media?: boolean;
};

// Every payload built here carries accessible text even though Slack's upstream
// argument type is a union where some members do not expose `text` or `blocks`.
export type SlackPostMessagePayload = ChatPostMessageArguments & SlackBasePostMessagePayload;
