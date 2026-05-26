import type { RuntimeEnv } from "../runtime.js";
import { type GatewayDaemonRuntime } from "./daemon-runtime.js";
export declare function maybeInstallDaemon(params: {
    runtime: RuntimeEnv;
    port: number;
    daemonRuntime?: GatewayDaemonRuntime;
}): Promise<void>;
