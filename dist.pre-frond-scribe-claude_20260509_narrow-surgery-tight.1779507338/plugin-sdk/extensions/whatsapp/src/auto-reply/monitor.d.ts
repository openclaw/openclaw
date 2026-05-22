import { type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { attachWebInboxToSocket } from "../inbound/monitor.js";
import type { WebMonitorTuning } from "./types.js";
type ReplyResolver = typeof import("./reply-resolver.runtime.js").getReplyFromConfig;
export declare function monitorWebChannel(verbose: boolean, listenerFactory?: typeof attachWebInboxToSocket | undefined, keepAlive?: boolean, replyResolver?: ReplyResolver, runtime?: RuntimeEnv, abortSignal?: AbortSignal, tuning?: WebMonitorTuning): Promise<void>;
export {};
