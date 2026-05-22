import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { type CompactionCounterAttribution } from "./compaction-attribution.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
export declare function handleCompactionStart(ctx: EmbeddedPiSubscribeContext, evt?: AgentEvent & {
    reason?: unknown;
}): void;
export declare function handleCompactionEnd(ctx: EmbeddedPiSubscribeContext, evt: AgentEvent & {
    reason?: unknown;
    willRetry?: unknown;
    result?: unknown;
    aborted?: unknown;
    errorMessage?: unknown;
}): void;
export declare function reconcileSessionStoreCompactionCountAfterSuccess(params: {
    sessionKey?: string;
    agentId?: string;
    configStore?: string;
    observedCompactionCount: number;
    now?: number;
    attribution?: CompactionCounterAttribution;
}): Promise<number | undefined>;
