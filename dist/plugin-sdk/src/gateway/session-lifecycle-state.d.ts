import { type SessionEntry } from "../config/sessions.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import type { GatewaySessionRow } from "./session-utils.types.js";
type LifecycleEventLike = Pick<AgentEventPayload, "ts"> & {
    data?: {
        phase?: unknown;
        startedAt?: unknown;
        endedAt?: unknown;
        aborted?: unknown;
        stopReason?: unknown;
    };
};
type LifecycleSessionShape = Pick<GatewaySessionRow, "updatedAt" | "status" | "startedAt" | "endedAt" | "runtimeMs" | "abortedLastRun">;
type PersistedLifecycleSessionShape = Pick<SessionEntry, "updatedAt" | "status" | "startedAt" | "endedAt" | "runtimeMs" | "abortedLastRun">;
type GatewaySessionLifecycleSnapshot = Partial<LifecycleSessionShape>;
export declare function deriveGatewaySessionLifecycleSnapshot(params: {
    session?: Partial<LifecycleSessionShape> | null;
    event: LifecycleEventLike;
}): GatewaySessionLifecycleSnapshot;
export declare function derivePersistedSessionLifecyclePatch(params: {
    entry?: Partial<PersistedLifecycleSessionShape> | null;
    event: LifecycleEventLike;
}): Partial<PersistedLifecycleSessionShape>;
export declare function persistGatewaySessionLifecycleEvent(params: {
    sessionKey: string;
    event: LifecycleEventLike;
}): Promise<void>;
export {};
