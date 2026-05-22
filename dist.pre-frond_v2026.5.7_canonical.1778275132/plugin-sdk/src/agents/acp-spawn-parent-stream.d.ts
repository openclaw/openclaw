import type { DeliveryContext } from "../utils/delivery-context.types.js";
export declare function resolveAcpSpawnStreamLogPath(params: {
    childSessionKey: string;
}): string | undefined;
export declare function startAcpSpawnParentStreamRelay(params: {
    runId: string;
    parentSessionKey: string;
    childSessionKey: string;
    agentId: string;
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
