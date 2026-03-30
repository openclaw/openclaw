import { getReplyFromConfig } from "../../auto-reply/reply.js";
import { type RuntimeEnv } from "../../runtime.js";
import { monitorWebInbox } from "../inbound.js";
import type { WebMonitorTuning } from "./types.js";
export declare function monitorWebChannel(verbose: boolean, listenerFactory?: typeof monitorWebInbox | undefined, keepAlive?: boolean, replyResolver?: typeof getReplyFromConfig | undefined, runtime?: RuntimeEnv, abortSignal?: AbortSignal, tuning?: WebMonitorTuning): Promise<void>;
