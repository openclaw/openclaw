import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { N as MessageReceipt } from "./types-Bu3TUX-L.js";
import * as _$_slack_web_api0 from "@slack/web-api";
import { Block, KnownBlock, WebClient } from "@slack/web-api";

//#region extensions/slack/src/send.d.ts
type SlackSendIdentity = {
  username?: string;
  iconUrl?: string;
  iconEmoji?: string;
};
type SlackSendOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  mediaUrl?: string;
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  };
  uploadFileName?: string;
  uploadTitle?: string;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  client?: WebClient;
  threadTs?: string;
  replyBroadcast?: boolean;
  identity?: SlackSendIdentity;
  blocks?: (Block | KnownBlock)[];
};
type SlackSendResult = {
  messageId: string;
  channelId: string;
  receipt: MessageReceipt;
};
declare function sendMessageSlack(to: string, message: string, opts: SlackSendOpts): Promise<SlackSendResult>;
//#endregion
//#region extensions/slack/src/monitor/media-types.d.ts
type SlackMediaResult = {
  path: string;
  contentType?: string;
  placeholder: string;
};
//#endregion
//#region extensions/slack/src/actions.d.ts
type SlackActionClientOpts = {
  cfg?: OpenClawConfig;
  accountId?: string;
  token?: string;
  client?: WebClient;
};
type SlackMessageSummary = {
  ts?: string;
  text?: string;
  user?: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: Array<{
    name?: string;
    count?: number;
    users?: string[];
  }>; /** File attachments on this message. Present when the message has files. */
  files?: Array<{
    id?: string;
    name?: string;
    mimetype?: string;
  }>;
};
type SlackPin = {
  type?: string;
  message?: {
    ts?: string;
    text?: string;
  };
  file?: {
    id?: string;
    name?: string;
  };
};
declare function reactSlackMessage(channelId: string, messageId: string, emoji: string, opts?: SlackActionClientOpts): Promise<void>;
declare function removeSlackReaction(channelId: string, messageId: string, emoji: string, opts?: SlackActionClientOpts): Promise<void>;
declare function removeOwnSlackReactions(channelId: string, messageId: string, opts?: SlackActionClientOpts): Promise<string[]>;
declare function listSlackReactions(channelId: string, messageId: string, opts?: SlackActionClientOpts): Promise<SlackMessageSummary["reactions"]>;
declare function sendSlackMessage(to: string, content: string, opts: Omit<SlackActionClientOpts, "cfg"> & {
  cfg: OpenClawConfig;
  mediaUrl?: string;
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  };
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  threadTs?: string;
  replyBroadcast?: boolean;
  uploadFileName?: string;
  uploadTitle?: string;
  blocks?: (Block | KnownBlock)[];
}): Promise<SlackSendResult>;
declare function editSlackMessage(channelId: string, messageId: string, content: string, opts?: SlackActionClientOpts & {
  blocks?: (Block | KnownBlock)[];
}): Promise<void>;
declare function deleteSlackMessage(channelId: string, messageId: string, opts?: SlackActionClientOpts): Promise<void>;
declare function readSlackMessages(channelId: string, opts?: SlackActionClientOpts & {
  limit?: number;
  before?: string;
  after?: string;
  threadId?: string;
  messageId?: string;
}): Promise<{
  messages: SlackMessageSummary[];
  hasMore: boolean;
}>;
declare function getSlackMemberInfo(userId: string, opts?: SlackActionClientOpts): Promise<_$_slack_web_api0.UsersInfoResponse>;
declare function listSlackEmojis(opts?: SlackActionClientOpts): Promise<_$_slack_web_api0.EmojiListResponse>;
declare function pinSlackMessage(channelId: string, messageId: string, opts?: SlackActionClientOpts): Promise<void>;
declare function unpinSlackMessage(channelId: string, messageId: string, opts?: SlackActionClientOpts): Promise<void>;
declare function listSlackPins(channelId: string, opts?: SlackActionClientOpts): Promise<SlackPin[]>;
/**
 * Downloads a Slack file by ID and saves it to the local media store.
 * Fetches a fresh download URL via files.info to avoid using stale private URLs.
 * Returns null when the file cannot be found or downloaded.
 */
declare function downloadSlackFile(fileId: string, opts: SlackActionClientOpts & {
  maxBytes: number;
  channelId?: string;
  threadId?: string;
}): Promise<SlackMediaResult | null>;
//#endregion
//#region extensions/slack/src/blocks-input.d.ts
declare const SLACK_MAX_BLOCKS = 50;
declare function validateSlackBlocksArray(raw: unknown): (Block | KnownBlock)[];
declare function parseSlackBlocksInput(raw: unknown): (Block | KnownBlock)[] | undefined;
//#endregion
export { removeOwnSlackReactions as _, SlackMessageSummary as a, unpinSlackMessage as b, downloadSlackFile as c, listSlackEmojis as d, listSlackPins as f, readSlackMessages as g, reactSlackMessage as h, SlackActionClientOpts as i, editSlackMessage as l, pinSlackMessage as m, parseSlackBlocksInput as n, SlackPin as o, listSlackReactions as p, validateSlackBlocksArray as r, deleteSlackMessage as s, SLACK_MAX_BLOCKS as t, getSlackMemberInfo as u, removeSlackReaction as v, sendMessageSlack as x, sendSlackMessage as y };