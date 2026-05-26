import type { OpenClawConfig } from "../config/types.openclaw.js";
type CrestodianRescueDecision = {
    allowed: true;
    enabled: true;
    ownerDmOnly: boolean;
    pendingTtlMinutes: number;
    yolo: true;
    sandboxActive: false;
} | {
    allowed: false;
    enabled: boolean;
    ownerDmOnly: boolean;
    pendingTtlMinutes: number;
    yolo: boolean;
    sandboxActive: boolean;
    reason: "disabled" | "sandbox-active" | "not-yolo" | "not-owner" | "not-direct-message";
    message: string;
};
type CrestodianRescuePolicyInput = {
    cfg: OpenClawConfig;
    agentId?: string;
    senderIsOwner: boolean;
    isDirectMessage: boolean;
};
export declare function resolveCrestodianRescuePolicy(input: CrestodianRescuePolicyInput): CrestodianRescueDecision;
export {};
