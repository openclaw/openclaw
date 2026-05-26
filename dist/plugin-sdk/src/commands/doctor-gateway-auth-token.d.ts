import type { OpenClawConfig } from "../config/types.openclaw.js";
export { shouldRequireGatewayTokenForInstall } from "../gateway/auth-install-policy.js";
export declare function resolveGatewayAuthTokenForService(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): Promise<{
    token?: string;
    unavailableReason?: string;
}>;
