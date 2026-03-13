import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { DiscordActionConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/config.js";
import { type ActionGate } from "./common.js";
export declare function handleDiscordMessagingAction(action: string, params: Record<string, unknown>, isActionEnabled: ActionGate<DiscordActionConfig>, options?: {
    mediaLocalRoots?: readonly string[];
}, cfg?: OpenClawConfig): Promise<AgentToolResult<unknown>>;
