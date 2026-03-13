export declare const GATEWAY_LAUNCH_AGENT_LABEL = "ai.openclaw.gateway";
export declare const GATEWAY_SYSTEMD_SERVICE_NAME = "openclaw-gateway";
export declare const GATEWAY_WINDOWS_TASK_NAME = "OpenClaw Gateway";
export declare const GATEWAY_SERVICE_MARKER = "openclaw";
export declare const GATEWAY_SERVICE_KIND = "gateway";
export declare const NODE_LAUNCH_AGENT_LABEL = "ai.openclaw.node";
export declare const NODE_SYSTEMD_SERVICE_NAME = "openclaw-node";
export declare const NODE_WINDOWS_TASK_NAME = "OpenClaw Node";
export declare const NODE_SERVICE_MARKER = "openclaw";
export declare const NODE_SERVICE_KIND = "node";
export declare const NODE_WINDOWS_TASK_SCRIPT_NAME = "node.cmd";
export declare const LEGACY_GATEWAY_LAUNCH_AGENT_LABELS: string[];
export declare const LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES: string[];
export declare const LEGACY_GATEWAY_WINDOWS_TASK_NAMES: string[];
export declare function normalizeGatewayProfile(profile?: string): string | null;
export declare function resolveGatewayProfileSuffix(profile?: string): string;
export declare function resolveGatewayLaunchAgentLabel(profile?: string): string;
export declare function resolveLegacyGatewayLaunchAgentLabels(profile?: string): string[];
export declare function resolveGatewaySystemdServiceName(profile?: string): string;
export declare function resolveGatewayWindowsTaskName(profile?: string): string;
export declare function formatGatewayServiceDescription(params?: {
    profile?: string;
    version?: string;
}): string;
export declare function resolveGatewayServiceDescription(params: {
    env: Record<string, string | undefined>;
    environment?: Record<string, string | undefined>;
    description?: string;
}): string;
export declare function resolveNodeLaunchAgentLabel(): string;
export declare function resolveNodeSystemdServiceName(): string;
export declare function resolveNodeWindowsTaskName(): string;
export declare function formatNodeServiceDescription(params?: {
    version?: string;
}): string;
