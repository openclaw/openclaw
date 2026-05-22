import type { GatewayAuthConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type SupportedGatewaySecretInputPath } from "./secret-input-paths.js";
type GatewayAuthSecretInputPath = Extract<SupportedGatewaySecretInputPath, "gateway.auth.token" | "gateway.auth.password">;
type GatewayAuthSecretRefResolutionParams = {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    mode?: GatewayAuthConfig["mode"];
    hasPasswordCandidate: boolean;
    hasTokenCandidate: boolean;
};
export declare function hasConfiguredGatewayAuthSecretInput(cfg: OpenClawConfig, path: GatewayAuthSecretInputPath): boolean;
export declare function resolveGatewayTokenSecretRefValue(params: GatewayAuthSecretRefResolutionParams): Promise<string | undefined>;
export declare function resolveGatewayPasswordSecretRefValue(params: GatewayAuthSecretRefResolutionParams): Promise<string | undefined>;
export declare function materializeGatewayAuthSecretRefs(params: GatewayAuthSecretRefResolutionParams): Promise<OpenClawConfig>;
export {};
