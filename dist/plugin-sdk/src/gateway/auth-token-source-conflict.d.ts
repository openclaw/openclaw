import type { OpenClawConfig } from "../config/types.openclaw.js";
export type GatewayAuthTokenSourceConflict = {
    checkId: "gateway.env_token_overrides_config";
    title: string;
    detail: string;
    remediation: string;
    warningLines: string[];
    diagnostic: string;
};
export declare function resolveGatewayAuthTokenSourceConflict(params: {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
}): GatewayAuthTokenSourceConflict | null;
