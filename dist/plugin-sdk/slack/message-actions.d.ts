import type { ChannelMessageActionName, ChannelToolSend } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
export declare function listSlackMessageActions(cfg: OpenClawConfig): ChannelMessageActionName[];
export declare function extractSlackToolSend(args: Record<string, unknown>): ChannelToolSend | null;
