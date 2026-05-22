import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ActionGate, DiscordActionConfig, OpenClawConfig } from "../runtime-api.js";
import { type DiscordMessagingActionOptions } from "./runtime.messaging.shared.js";
export { discordMessagingActionRuntime } from "./runtime.messaging.runtime.js";
export declare function handleDiscordMessagingAction(action: string, params: Record<string, unknown>, isActionEnabled: ActionGate<DiscordActionConfig>, cfg: OpenClawConfig, options?: DiscordMessagingActionOptions): Promise<AgentToolResult<unknown>>;
