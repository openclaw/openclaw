export type GatewayDaemonRuntime = "node" | "bun";
export declare const DEFAULT_GATEWAY_DAEMON_RUNTIME: GatewayDaemonRuntime;
export declare const GATEWAY_DAEMON_RUNTIME_OPTIONS: Array<{
    value: GatewayDaemonRuntime;
    label: string;
    hint?: string;
}>;
export declare function isGatewayDaemonRuntime(value: string | undefined): value is GatewayDaemonRuntime;
