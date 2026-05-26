import type { OpenClawConfig } from "../../config/types.openclaw.js";
export declare function resolveGatewayTokenForDriftCheck(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
}): Promise<string | undefined>;
