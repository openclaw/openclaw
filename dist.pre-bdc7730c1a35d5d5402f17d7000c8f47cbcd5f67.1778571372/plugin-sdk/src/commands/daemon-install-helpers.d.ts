import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.js";
import type { GatewayServiceEnvironmentValueSource } from "../daemon/service-types.js";
import type { DaemonInstallWarnFn } from "./daemon-install-runtime-warning.js";
import type { GatewayDaemonRuntime } from "./daemon-runtime.js";
export { resolveGatewayDevMode } from "./daemon-install-plan.shared.js";
type GatewayInstallPlan = {
    programArguments: string[];
    workingDirectory?: string;
    environment: Record<string, string | undefined>;
    environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource | undefined>;
};
export declare function buildGatewayInstallPlan(params: {
    env: Record<string, string | undefined>;
    port: number;
    runtime: GatewayDaemonRuntime;
    existingEnvironment?: Record<string, string | undefined>;
    devMode?: boolean;
    nodePath?: string;
    wrapperPath?: string;
    platform?: NodeJS.Platform;
    warn?: DaemonInstallWarnFn;
    /** Full config to extract env vars from (env vars + inline env keys). */
    config?: OpenClawConfig;
    authStore?: AuthProfileStore;
    existingEnvironmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource | undefined>;
}): Promise<GatewayInstallPlan>;
export declare function gatewayInstallErrorHint(platform?: NodeJS.Platform): string;
