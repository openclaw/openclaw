import type { ChannelMessageActionName } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { type ChannelToolSend } from "openclaw/plugin-sdk/tool-send";
export declare function listSlackMessageActions(cfg: OpenClawConfig, accountId?: string | null): ChannelMessageActionName[];
export declare function extractSlackToolSend(args: Record<string, unknown>): ChannelToolSend | null;
