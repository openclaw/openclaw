import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
type SlackActionInvoke = (action: Record<string, unknown>, cfg: unknown, toolContext: unknown) => Promise<AgentToolResult<unknown>>;
export declare function createSlackActions(providerId: string, options?: {
    invoke?: SlackActionInvoke;
}): ChannelMessageActionAdapter;
export {};
