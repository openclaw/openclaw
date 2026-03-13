import { type DiscordInboundJob } from "./inbound-job.js";
import type { RuntimeEnv } from "./message-handler.preflight.types.js";
import type { DiscordMonitorStatusSink } from "./status.js";
type DiscordInboundWorkerParams = {
    runtime: RuntimeEnv;
    setStatus?: DiscordMonitorStatusSink;
    abortSignal?: AbortSignal;
    runTimeoutMs?: number;
};
export type DiscordInboundWorker = {
    enqueue: (job: DiscordInboundJob) => void;
    deactivate: () => void;
};
export declare function createDiscordInboundWorker(params: DiscordInboundWorkerParams): DiscordInboundWorker;
export {};
