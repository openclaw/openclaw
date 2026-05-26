import { type EventSessionRoutingPolicy } from "../infra/event-session-routing.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
export declare function resolveAcpSpawnStreamLogPath(params: {
    childSessionKey: string;
}): string | undefined;
export declare function startAcpSpawnParentStreamRelay(params: {
    runId: string;
    parentSessionKey: string;
    childSessionKey: string;
    agentId: string;
    /**
     * Optional `session.mainKey` from the runtime config. Used to remap
     * cron-run parent session keys to the agent's main queue when relaying
     * events. Caller passes the spawn-time `cfg.session?.mainKey`; pass-through
     * of `undefined` falls back to the literal "main" default. Long-running
     * relays keep using that start-time value if config changes while the child
     * session is still streaming.
     */
    mainKey?: string;
    /**
     * Optional `session.scope` from the runtime config. Required so global-scope
     * agents route cron-run events to the "global" queue instead of agent-main.
     * Snapshotted with `mainKey` for the same start-time routing reason.
     */
    sessionScope?: "per-sender" | "global";
    eventRouting?: EventSessionRoutingPolicy;
    logPath?: string;
    deliveryContext?: DeliveryContext;
    surfaceUpdates?: boolean;
    streamFlushMs?: number;
    noOutputNoticeMs?: number;
    noOutputPollMs?: number;
    maxRelayLifetimeMs?: number;
    emitStartNotice?: boolean;
}): AcpSpawnParentRelayHandle;
export type AcpSpawnParentRelayHandle = {
    dispose: () => void;
    notifyStarted: () => void;
};
