import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ExplicitGatewayAuth } from "./credentials.js";
export declare function resolveGatewayUrlOverrideSource(urlSource: string): "cli" | "env" | undefined;
export declare function resolveGatewayClientBootstrap(params: {
    config: OpenClawConfig;
    gatewayUrl?: string;
    explicitAuth?: ExplicitGatewayAuth;
    env?: NodeJS.ProcessEnv;
}): Promise<{
    url: string;
    urlSource: string;
    preauthHandshakeTimeoutMs?: number;
    auth: {
        token?: string;
        password?: string;
    };
}>;
