import type { DiscordMessagePreflightContext } from "./message-handler.preflight.types.js";
type DiscordInboundJobRuntimeField = "runtime" | "abortSignal" | "guildHistories" | "client" | "threadBindings" | "discordRestFetch";
export type DiscordInboundJobRuntime = Pick<DiscordMessagePreflightContext, DiscordInboundJobRuntimeField>;
export type DiscordInboundJobPayload = Omit<DiscordMessagePreflightContext, DiscordInboundJobRuntimeField>;
export type DiscordInboundJob = {
    queueKey: string;
    payload: DiscordInboundJobPayload;
    runtime: DiscordInboundJobRuntime;
};
export declare function resolveDiscordInboundJobQueueKey(ctx: DiscordMessagePreflightContext): string;
export declare function buildDiscordInboundJob(ctx: DiscordMessagePreflightContext): DiscordInboundJob;
export declare function materializeDiscordInboundJob(job: DiscordInboundJob, abortSignal?: AbortSignal): DiscordMessagePreflightContext;
export {};
