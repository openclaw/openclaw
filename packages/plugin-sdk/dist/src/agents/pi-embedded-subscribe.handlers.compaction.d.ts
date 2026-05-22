import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
type SessionCompactionStartEvent = Extract<AgentSessionEvent, {
    type: "compaction_start";
}>;
type SessionCompactionEndEvent = Extract<AgentSessionEvent, {
    type: "compaction_end";
}>;
type CompactionStartEvent = SessionCompactionStartEvent | {
    type: "compaction_start";
    reason?: unknown;
};
type CompactionEndEvent = SessionCompactionEndEvent | {
    type: "compaction_end";
    reason?: unknown;
    willRetry?: unknown;
    result?: unknown;
    aborted?: unknown;
};
export declare function handleCompactionStart(ctx: EmbeddedPiSubscribeContext, evt: CompactionStartEvent): void;
export declare function handleCompactionEnd(ctx: EmbeddedPiSubscribeContext, evt: CompactionEndEvent): void;
export declare function reconcileSessionStoreCompactionCountAfterSuccess(params: {
    sessionKey?: string;
    agentId?: string;
    configStore?: string;
    observedCompactionCount: number;
    now?: number;
}): Promise<number | undefined>;
export {};
