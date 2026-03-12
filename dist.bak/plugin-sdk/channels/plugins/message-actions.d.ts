import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";
import type { ChannelMessageActionContext, ChannelMessageActionName } from "./types.js";
export declare function listChannelMessageActions(cfg: OpenClawConfig): ChannelMessageActionName[];
export declare function supportsChannelMessageButtons(cfg: OpenClawConfig): boolean;
export declare function supportsChannelMessageButtonsForChannel(params: {
    cfg: OpenClawConfig;
    channel?: string;
}): boolean;
export declare function supportsChannelMessageCards(cfg: OpenClawConfig): boolean;
export declare function supportsChannelMessageCardsForChannel(params: {
    cfg: OpenClawConfig;
    channel?: string;
}): boolean;
export declare function dispatchChannelMessageAction(ctx: ChannelMessageActionContext): Promise<AgentToolResult<unknown> | null>;
