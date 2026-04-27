import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentInternalEvent } from "./internal-events.js";
import { callGateway, loadConfig, queueEmbeddedPiMessage, sendMessage } from "./subagent-announce-delivery.runtime.js";
import { type SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import { type DeliveryContext } from "./subagent-announce-origin.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";
export { resolveAnnounceOrigin } from "./subagent-announce-origin.js";
type SubagentAnnounceDeliveryDeps = {
    callGateway: typeof callGateway;
    loadConfig: typeof loadConfig;
    getRequesterSessionActivity: (requesterSessionKey: string) => {
        sessionId?: string;
        isActive: boolean;
    };
    queueEmbeddedPiMessage: typeof queueEmbeddedPiMessage;
    sendMessage: typeof sendMessage;
};
export declare function resolveSubagentAnnounceTimeoutMs(cfg: OpenClawConfig): number;
export declare function isInternalAnnounceRequesterSession(sessionKey: string | undefined): boolean;
export declare function runAnnounceDeliveryWithRetry<T>(params: {
    operation: string;
    signal?: AbortSignal;
    run: () => Promise<T>;
}): Promise<T>;
export declare function resolveSubagentCompletionOrigin(params: {
    childSessionKey: string;
    requesterSessionKey: string;
    requesterOrigin?: DeliveryContext;
    childRunId?: string;
    spawnMode?: SpawnSubagentMode;
    expectsCompletionMessage: boolean;
}): Promise<DeliveryContext | undefined>;
export declare function loadRequesterSessionEntry(requesterSessionKey: string): {
    cfg: OpenClawConfig;
    entry: import("../config/sessions.js").SessionEntry;
    canonicalKey: string;
};
export declare function loadSessionEntryByKey(sessionKey: string): import("../config/sessions.js").SessionEntry;
export declare function extractThreadCompletionFallbackText(internalEvents?: AgentInternalEvent[]): string;
export declare function deliverSubagentAnnouncement(params: {
    requesterSessionKey: string;
    announceId?: string;
    triggerMessage: string;
    steerMessage: string;
    internalEvents?: AgentInternalEvent[];
    summaryLine?: string;
    requesterSessionOrigin?: DeliveryContext;
    requesterOrigin?: DeliveryContext;
    completionDirectOrigin?: DeliveryContext;
    directOrigin?: DeliveryContext;
    sourceSessionKey?: string;
    sourceChannel?: string;
    sourceTool?: string;
    targetRequesterSessionKey: string;
    requesterIsSubagent: boolean;
    expectsCompletionMessage: boolean;
    bestEffortDeliver?: boolean;
    directIdempotencyKey: string;
    signal?: AbortSignal;
}): Promise<SubagentAnnounceDeliveryResult>;
export declare const __testing: {
    setDepsForTest(overrides?: Partial<SubagentAnnounceDeliveryDeps>): void;
};
