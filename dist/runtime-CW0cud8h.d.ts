import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { n as PluginRuntime } from "./types-DtDIgr2k.js";
import { _ as removeOwnSlackReactions, b as unpinSlackMessage, c as downloadSlackFile, d as listSlackEmojis, f as listSlackPins, g as readSlackMessages, h as reactSlackMessage, l as editSlackMessage, m as pinSlackMessage, n as parseSlackBlocksInput, p as listSlackReactions, s as deleteSlackMessage, u as getSlackMemberInfo, v as removeSlackReaction, y as sendSlackMessage } from "./blocks-input-B2E-OvVy.js";
import { AgentToolResult } from "@earendil-works/pi-agent-core";

//#region extensions/slack/src/action-runtime.d.ts
declare const slackActionRuntime: {
  deleteSlackMessage: typeof deleteSlackMessage;
  downloadSlackFile: typeof downloadSlackFile;
  editSlackMessage: typeof editSlackMessage;
  getSlackMemberInfo: typeof getSlackMemberInfo;
  listSlackEmojis: typeof listSlackEmojis;
  listSlackPins: typeof listSlackPins;
  listSlackReactions: typeof listSlackReactions;
  parseSlackBlocksInput: typeof parseSlackBlocksInput;
  pinSlackMessage: typeof pinSlackMessage;
  reactSlackMessage: typeof reactSlackMessage;
  readSlackMessages: typeof readSlackMessages;
  removeOwnSlackReactions: typeof removeOwnSlackReactions;
  removeSlackReaction: typeof removeSlackReaction;
  sendSlackMessage: typeof sendSlackMessage;
  unpinSlackMessage: typeof unpinSlackMessage;
};
type SlackActionContext = {
  /** Current channel ID for auto-threading. */currentChannelId?: string; /** Current thread timestamp for auto-threading. */
  currentThreadTs?: string; /** Reply-to mode for auto-threading. */
  replyToMode?: "off" | "first" | "all" | "batched"; /** Mutable ref to track if a reply was sent for single-use reply modes. */
  hasRepliedRef?: {
    value: boolean;
  }; /** Allowed local media directories for file uploads. */
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
};
declare function handleSlackAction(params: Record<string, unknown>, cfg: OpenClawConfig, context?: SlackActionContext): Promise<AgentToolResult<unknown>>;
//#endregion
//#region extensions/slack/src/runtime.d.ts
type SlackChannelRuntime = {
  handleSlackAction?: typeof handleSlackAction;
};
type SlackRuntime = PluginRuntime & {
  channel: PluginRuntime["channel"] & {
    slack?: SlackChannelRuntime;
  };
};
declare const setSlackRuntime: (next: SlackRuntime) => void, clearSlackRuntime: () => void, getOptionalSlackRuntime: () => SlackRuntime | null;
//#endregion
export { slackActionRuntime as i, SlackActionContext as n, handleSlackAction as r, setSlackRuntime as t };