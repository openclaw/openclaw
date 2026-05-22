import type { EventEmitter } from "node:events";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
type GatewayEmitter = Pick<EventEmitter, "on" | "removeListener">;
export declare function attachDiscordGatewayLogging(params: {
    emitter?: GatewayEmitter;
    runtime: RuntimeEnv;
}): () => void;
export {};
