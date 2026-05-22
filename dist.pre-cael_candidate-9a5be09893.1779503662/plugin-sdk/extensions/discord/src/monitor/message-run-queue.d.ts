import type { ClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { type DiscordInboundJob } from "./inbound-job.js";
import type { RuntimeEnv } from "./message-handler.preflight.types.js";
import type { DiscordMonitorStatusSink } from "./status.js";
type ProcessDiscordMessage = typeof import("./message-handler.process.js").processDiscordMessage;
type DiscordMessageRunQueueParams = {
    runtime: RuntimeEnv;
    setStatus?: DiscordMonitorStatusSink;
    abortSignal?: AbortSignal;
    replayGuard?: ClaimableDedupe;
    testing?: DiscordMessageRunQueueTestingHooks;
};
type DiscordMessageRunQueue = {
    enqueue: (job: DiscordInboundJob) => void;
    deactivate: () => void;
};
export type DiscordMessageRunQueueTestingHooks = {
    processDiscordMessage?: ProcessDiscordMessage;
};
export declare function createDiscordMessageRunQueue(params: DiscordMessageRunQueueParams): DiscordMessageRunQueue;
export {};
