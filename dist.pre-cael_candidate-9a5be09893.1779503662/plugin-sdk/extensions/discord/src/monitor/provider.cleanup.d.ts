import { type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { MutableDiscordGateway } from "./gateway-handle.js";
import type { DiscordMonitorStatusSink } from "./status.js";
import type { ThreadBindingManager } from "./thread-bindings.js";
type EventEmitterLike = {
    removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
};
export declare function cleanupDiscordProviderStartup(params: {
    deactivateMessageHandler?: () => void;
    autoPresenceController?: {
        stop: () => void;
    } | null;
    setStatus?: DiscordMonitorStatusSink;
    onEarlyGatewayDebug?: ((msg: unknown) => void) | undefined;
    earlyGatewayEmitter?: EventEmitterLike | undefined;
    lifecycleStarted: boolean;
    lifecycleGateway?: MutableDiscordGateway;
    gatewaySupervisor?: {
        dispose: () => void;
    };
    threadBindings: ThreadBindingManager;
    runtime: RuntimeEnv;
}): void;
export {};
