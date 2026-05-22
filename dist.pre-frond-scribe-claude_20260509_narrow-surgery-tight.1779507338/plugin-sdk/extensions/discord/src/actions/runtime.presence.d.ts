import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ActionGate, type DiscordActionConfig } from "../runtime-api.js";
export declare function handleDiscordPresenceAction(action: string, params: Record<string, unknown>, isActionEnabled: ActionGate<DiscordActionConfig>): Promise<AgentToolResult<unknown>>;
