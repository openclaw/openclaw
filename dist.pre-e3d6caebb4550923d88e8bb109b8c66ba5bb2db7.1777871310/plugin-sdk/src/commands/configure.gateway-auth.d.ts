import type { OpenClawConfig, GatewayAuthConfig } from "../config/config.js";
import { type SecretInput } from "../config/types.secrets.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
type GatewayAuthChoice = "token" | "password" | "trusted-proxy";
export declare function buildGatewayAuthConfig(params: {
    existing?: GatewayAuthConfig;
    mode: GatewayAuthChoice;
    token?: SecretInput;
    password?: string;
    trustedProxy?: {
        userHeader: string;
        requiredHeaders?: string[];
        allowUsers?: string[];
    };
}): GatewayAuthConfig | undefined;
export declare function promptAuthConfig(cfg: OpenClawConfig, runtime: RuntimeEnv, prompter: WizardPrompter): Promise<OpenClawConfig>;
export {};
