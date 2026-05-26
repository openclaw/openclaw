import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type NodeWakeAttempt } from "./nodes-wake-state.js";
import type { GatewayRequestHandlers } from "./types.js";
export { clearNodeWakeState, NODE_WAKE_RECONNECT_RETRY_WAIT_MS, NODE_WAKE_RECONNECT_WAIT_MS, } from "./nodes-wake-state.js";
type NodeWakeNudgeAttempt = {
    sent: boolean;
    throttled: boolean;
    reason: "throttled" | "no-registration" | "no-auth" | "send-error" | "apns-not-ok" | "sent";
    durationMs: number;
    apnsStatus?: number;
    apnsReason?: string;
};
export declare function maybeWakeNodeWithApns(nodeId: string, opts?: {
    force?: boolean;
    wakeReason?: string;
    cfg?: OpenClawConfig;
}): Promise<NodeWakeAttempt>;
export declare function maybeSendNodeWakeNudge(nodeId: string, opts?: {
    cfg?: OpenClawConfig;
}): Promise<NodeWakeNudgeAttempt>;
export declare function waitForNodeReconnect(params: {
    nodeId: string;
    context: {
        nodeRegistry: {
            get: (nodeId: string) => unknown;
        };
    };
    timeoutMs?: number;
    pollMs?: number;
}): Promise<boolean>;
export declare const nodeHandlers: GatewayRequestHandlers;
