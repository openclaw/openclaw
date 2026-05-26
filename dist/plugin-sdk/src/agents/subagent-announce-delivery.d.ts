import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentInternalEvent } from "./internal-events.js";
import type { EmbeddedPiQueueMessageOptions } from "./pi-embedded-runner/run-state.js";
import type { EmbeddedPiQueueMessageOutcome } from "./pi-embedded-runner/runs.js";
import { callGateway, dispatchGatewayMethodInProcess, getRuntimeConfig, sendMessage } from "./subagent-announce-delivery.runtime.js";
import { type SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import type { DeliveryContext } from "./subagent-announce-origin.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";
type SubagentAnnounceDeliveryDeps = {
    dispatchGatewayMethodInProcess: typeof dispatchGatewayMethodInProcess;
    getRuntimeConfig: typeof getRuntimeConfig;
    getRequesterSessionActivity: (requesterSessionKey: string) => {
        sessionId?: string;
        isActive: boolean;
    };
    queueEmbeddedPiMessageWithOutcome: (sessionId: string, text: string, options?: EmbeddedPiQueueMessageOptions) => EmbeddedPiQueueMessageOutcome | Promise<EmbeddedPiQueueMessageOutcome>;
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
    entry: import("openclaw/plugin-sdk/config-types").SessionEntry;
    canonicalKey: string;
};
export declare function loadSessionEntryByKey(sessionKey: string): import("openclaw/plugin-sdk/config-types").SessionEntry;
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
export declare const testing: {
    setDepsForTest(overrides?: Partial<SubagentAnnounceDeliveryDeps> & {
        callGateway?: typeof callGateway;
    }): void;
};
export { testing as __testing };
