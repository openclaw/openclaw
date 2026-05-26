import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { SecretInputMode } from "./onboard-types.js";
export declare function promptRemoteGatewayConfig(cfg: OpenClawConfig, prompter: WizardPrompter, options?: {
    secretInputMode?: SecretInputMode;
}): Promise<OpenClawConfig>;
