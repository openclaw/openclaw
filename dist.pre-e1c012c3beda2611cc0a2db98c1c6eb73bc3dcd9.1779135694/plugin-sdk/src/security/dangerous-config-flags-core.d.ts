import type { OpenClawConfig } from "../config/types.openclaw.js";
type DangerousFlagValue = string | number | boolean | null;
type DangerousFlagContract = {
    path: string;
    equals: DangerousFlagValue;
};
type PluginConfigContractMetadata = {
    configContracts: {
        dangerousFlags?: DangerousFlagContract[];
    };
};
type PluginConfigContractMatch = {
    path: string;
    value: unknown;
};
type CollectPluginConfigContractMatches = (input: {
    pathPattern: string;
    root: Record<string, unknown>;
}) => Iterable<PluginConfigContractMatch>;
export type DangerousConfigFlagContractInputs = {
    configContractsById?: ReadonlyMap<string, PluginConfigContractMetadata>;
    collectPluginConfigContractMatches?: CollectPluginConfigContractMatches;
};
export declare function collectEnabledInsecureOrDangerousFlagsFromContracts(cfg: OpenClawConfig, inputs?: DangerousConfigFlagContractInputs): string[];
export {};
