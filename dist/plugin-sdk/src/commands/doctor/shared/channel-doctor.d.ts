import type { ChannelDoctorConfigMutation, ChannelDoctorEmptyAllowlistAccountContext, ChannelDoctorSequenceResult } from "../../../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
type ChannelDoctorLookupContext = {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
};
type ChannelDoctorEmptyAllowlistLookupParams = ChannelDoctorEmptyAllowlistAccountContext & {
    cfg?: OpenClawConfig;
};
export type ChannelDoctorEmptyAllowlistPolicyHooks = {
    extraWarningsForAccount: (params: ChannelDoctorEmptyAllowlistAccountContext) => string[];
    shouldSkipDefaultEmptyGroupAllowlistWarning: (params: ChannelDoctorEmptyAllowlistAccountContext) => boolean;
};
export declare function createChannelDoctorEmptyAllowlistPolicyHooks(context: ChannelDoctorLookupContext): ChannelDoctorEmptyAllowlistPolicyHooks;
export declare function runChannelDoctorConfigSequences(params: {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    shouldRepair: boolean;
}): Promise<ChannelDoctorSequenceResult>;
export declare function collectChannelDoctorCompatibilityMutations(cfg: OpenClawConfig, options?: {
    env?: NodeJS.ProcessEnv;
}): ChannelDoctorConfigMutation[];
export declare function collectChannelDoctorStaleConfigMutations(cfg: OpenClawConfig, options?: {
    env?: NodeJS.ProcessEnv;
}): Promise<ChannelDoctorConfigMutation[]>;
export declare function collectChannelDoctorPreviewWarnings(params: {
    cfg: OpenClawConfig;
    doctorFixCommand: string;
    env?: NodeJS.ProcessEnv;
}): Promise<string[]>;
export declare function collectChannelDoctorMutableAllowlistWarnings(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
}): Promise<string[]>;
export declare function collectChannelDoctorRepairMutations(params: {
    cfg: OpenClawConfig;
    doctorFixCommand: string;
    env?: NodeJS.ProcessEnv;
}): Promise<ChannelDoctorConfigMutation[]>;
export declare function collectChannelDoctorEmptyAllowlistExtraWarnings(params: ChannelDoctorEmptyAllowlistLookupParams): string[];
export declare function shouldSkipChannelDoctorDefaultEmptyGroupAllowlistWarning(params: ChannelDoctorEmptyAllowlistLookupParams): boolean;
export {};
