import type { DiscordMessagePreflightContext } from "./message-handler.preflight.types.js";
type DiscordInboundJobRuntimeField = "runtime" | "abortSignal" | "guildHistories" | "client" | "threadBindings" | "discordRestFetch";
type DiscordInboundJobRuntime = Pick<DiscordMessagePreflightContext, DiscordInboundJobRuntimeField>;
type DiscordInboundJobPayload = Omit<DiscordMessagePreflightContext, DiscordInboundJobRuntimeField>;
export type DiscordInboundJob = {
    queueKey: string;
    payload: DiscordInboundJobPayload;
    runtime: DiscordInboundJobRuntime;
    replayKeys?: string[];
};
export declare function resolveDiscordInboundJobQueueKey(ctx: DiscordMessagePreflightContext): string;
export declare function buildDiscordInboundJob(ctx: DiscordMessagePreflightContext, options?: {
    replayKeys?: readonly string[];
}): DiscordInboundJob;
export declare function materializeDiscordInboundJob(job: DiscordInboundJob, abortSignal?: AbortSignal): DiscordMessagePreflightContext;
export {};
