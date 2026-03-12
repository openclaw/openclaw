import { type SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import type { DiscordMessagePreflightContext, DiscordMessagePreflightParams } from "./message-handler.preflight.types.js";
export type { DiscordMessagePreflightContext, DiscordMessagePreflightParams, } from "./message-handler.preflight.types.js";
export declare function resolvePreflightMentionRequirement(params: {
    shouldRequireMention: boolean;
    isBoundThreadSession: boolean;
}): boolean;
export declare function shouldIgnoreBoundThreadWebhookMessage(params: {
    accountId?: string;
    threadId?: string;
    webhookId?: string | null;
    threadBinding?: SessionBindingRecord;
}): boolean;
export declare function preflightDiscordMessage(params: DiscordMessagePreflightParams): Promise<DiscordMessagePreflightContext | null>;
