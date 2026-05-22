import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { DiscordVoiceManager } from "../voice/manager.js";
import { type MutableDiscordGateway } from "./gateway-handle.js";
import { type DiscordGatewaySupervisor } from "./gateway-supervisor.js";
import type { DiscordMonitorStatusSink } from "./status.js";
export declare function resolveDiscordGatewayReadyTimeoutMs(params?: {
    configuredTimeoutMs?: number;
    env?: NodeJS.ProcessEnv;
}): number;
export declare function resolveDiscordGatewayRuntimeReadyTimeoutMs(params?: {
    configuredTimeoutMs?: number;
    env?: NodeJS.ProcessEnv;
}): number;
export declare function runDiscordGatewayLifecycle(params: {
    accountId: string;
    gateway?: MutableDiscordGateway;
    runtime: RuntimeEnv;
    abortSignal?: AbortSignal;
    isDisallowedIntentsError: (err: unknown) => boolean;
    voiceManager: DiscordVoiceManager | null;
    voiceManagerRef: {
        current: DiscordVoiceManager | null;
    };
    threadBindings: {
        stop: () => void;
    };
    gatewaySupervisor: DiscordGatewaySupervisor;
    statusSink?: DiscordMonitorStatusSink;
    gatewayReadyTimeoutMs?: number;
    gatewayRuntimeReadyTimeoutMs?: number;
}): Promise<void>;
