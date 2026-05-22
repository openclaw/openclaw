import { type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { GatewayPlugin } from "../internal/gateway.js";
export declare function logDiscordStartupPhase(params: {
    runtime: RuntimeEnv;
    accountId: string;
    phase: string;
    startAt: number;
    gateway?: GatewayPlugin;
    details?: string;
    isVerbose?: () => boolean;
}): void;
