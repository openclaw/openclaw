import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-plugin-common";
import { type ThreadBindingTargetKind } from "./monitor/thread-bindings.js";
type DiscordSubagentSpawningEvent = {
    threadRequested?: boolean;
    requester?: {
        channel?: string;
        accountId?: string;
        to?: string;
        threadId?: string | number;
    };
    childSessionKey: string;
    agentId: string;
    label?: string;
};
type DiscordSubagentEndedEvent = {
    targetSessionKey: string;
    accountId?: string;
    targetKind?: ThreadBindingTargetKind;
    reason?: string;
    sendFarewell?: boolean;
};
type DiscordSubagentDeliveryTargetEvent = {
    expectsCompletionMessage?: boolean;
    childSessionKey: string;
    requesterOrigin?: {
        channel?: string;
        accountId?: string;
        threadId?: string | number;
    };
};
type DiscordSubagentSpawningResult = {
    status: "ok";
    threadBindingReady?: boolean;
    deliveryOrigin?: {
        channel: "discord";
        accountId?: string;
        to: string;
        threadId?: string | number;
    };
} | {
    status: "error";
    error: string;
} | undefined;
type DiscordSubagentDeliveryTargetResult = {
    origin: {
        channel: "discord";
        accountId?: string;
        to: string;
        threadId?: string | number;
    };
} | undefined;
export declare function handleDiscordSubagentSpawning(api: OpenClawPluginApi, event: DiscordSubagentSpawningEvent): Promise<DiscordSubagentSpawningResult>;
export declare function handleDiscordSubagentEnded(event: DiscordSubagentEndedEvent): void;
export declare function handleDiscordSubagentDeliveryTarget(event: DiscordSubagentDeliveryTargetEvent): DiscordSubagentDeliveryTargetResult;
export {};
