import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMonitorContext } from "../context.js";
type SlackDmHistoryEntry = {
    sender: string;
    body: string;
    timestamp?: number;
};
export declare function resolveSlackDmHistoryLimit(params: {
    account: ResolvedSlackAccount;
    userId?: string;
    defaultLimit: number;
}): number;
export declare function resolveSlackDmHistoryContext(params: {
    ctx: SlackMonitorContext;
    channelId: string;
    currentMessageTs?: string;
    limit: number;
    envelopeOptions: ReturnType<typeof import("openclaw/plugin-sdk/channel-inbound").resolveEnvelopeFormatOptions>;
}): Promise<{
    body: string | undefined;
    inboundHistory: SlackDmHistoryEntry[] | undefined;
}>;
export {};
