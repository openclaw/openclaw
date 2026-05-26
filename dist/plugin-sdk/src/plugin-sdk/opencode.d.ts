import { type OpenClawConfig } from "./provider-auth-api-key.js";
export { applyOpencodeZenModelDefault, OPENCODE_ZEN_DEFAULT_MODEL } from "./provider-onboard.js";
export declare function createOpencodeCatalogApiKeyAuthMethod(params: {
    providerId: string;
    label: string;
    optionKey: string;
    flagName: `--${string}`;
    defaultModel: string;
    applyConfig: (cfg: OpenClawConfig) => OpenClawConfig;
    noteMessage: string;
    choiceId: string;
    choiceLabel: string;
}): import("./plugin-entry.ts").ProviderAuthMethod;
