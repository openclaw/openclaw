import type { GatewayServiceEnvironmentValueSource } from "./service-types.js";
export type GatewayServiceCommand = {
    programArguments: string[];
    workingDirectory?: string;
    environment?: Record<string, string>;
    environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource>;
    sourcePath?: string;
} | null;
export type ServiceConfigIssue = {
    code: string;
    message: string;
    detail?: string;
    level?: "recommended" | "aggressive";
};
export type ServiceConfigAudit = {
    ok: boolean;
    issues: ServiceConfigIssue[];
};
export declare const SERVICE_AUDIT_CODES: {
    readonly gatewayCommandMissing: "gateway-command-missing";
    readonly gatewayEntrypointMismatch: "gateway-entrypoint-mismatch";
    readonly gatewayPathMissing: "gateway-path-missing";
    readonly gatewayPathMissingDirs: "gateway-path-missing-dirs";
    readonly gatewayPathNonMinimal: "gateway-path-nonminimal";
    readonly gatewayTokenEmbedded: "gateway-token-embedded";
    readonly gatewayManagedEnvEmbedded: "gateway-managed-env-embedded";
    readonly gatewayPortMismatch: "gateway-port-mismatch";
    readonly gatewayProxyEnvEmbedded: "gateway-proxy-env-embedded";
    readonly gatewayTokenMismatch: "gateway-token-mismatch";
    readonly gatewayRuntimeBun: "gateway-runtime-bun";
    readonly gatewayRuntimeNodeVersionManager: "gateway-runtime-node-version-manager";
    readonly gatewayRuntimeNodeSystemMissing: "gateway-runtime-node-system-missing";
    readonly gatewayTokenDrift: "gateway-token-drift";
    readonly launchdKeepAlive: "launchd-keep-alive";
    readonly launchdRunAtLoad: "launchd-run-at-load";
    readonly systemdAfterNetworkOnline: "systemd-after-network-online";
    readonly systemdRestartSec: "systemd-restart-sec";
    readonly systemdWantsNetworkOnline: "systemd-wants-network-online";
};
export declare function needsNodeRuntimeMigration(issues: ServiceConfigIssue[]): boolean;
export declare function readGatewayServiceCommandPort(programArguments?: string[]): number | undefined;
export declare function readEmbeddedGatewayToken(command: GatewayServiceCommand): string | undefined;
/**
 * Check if the service's embedded token differs from the config file token.
 * Returns an issue if drift is detected (service will use old token after restart).
 */
export declare function checkTokenDrift(params: {
    serviceToken: string | undefined;
    configToken: string | undefined;
}): ServiceConfigIssue | null;
export declare function auditGatewayServiceConfig(params: {
    env: Record<string, string | undefined>;
    command: GatewayServiceCommand;
    platform?: NodeJS.Platform;
    expectedGatewayToken?: string;
    expectedManagedServiceEnvKeys?: Iterable<string>;
    expectedPort?: number;
}): Promise<ServiceConfigAudit>;
