import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { DiscordActionConfig } from "../../config/config.js";
import { type ActionGate } from "./common.js";
export declare function handleDiscordModerationAction(action: string, params: Record<string, unknown>, isActionEnabled: ActionGate<DiscordActionConfig>): Promise<AgentToolResult<unknown>>;
