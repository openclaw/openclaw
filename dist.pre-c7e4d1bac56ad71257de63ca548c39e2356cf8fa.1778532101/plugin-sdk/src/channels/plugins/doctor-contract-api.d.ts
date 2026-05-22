import type { LegacyConfigRule } from "../../config/legacy.shared.js";
import type { OpenClawConfig } from "../../config/types.js";
type BundledChannelDoctorCompatibilityMutation = {
    config: OpenClawConfig;
    changes: string[];
};
type BundledChannelDoctorContractApi = {
    legacyConfigRules?: readonly LegacyConfigRule[];
    normalizeCompatibilityConfig?: (params: {
        cfg: OpenClawConfig;
    }) => BundledChannelDoctorCompatibilityMutation;
};
export declare function loadBundledChannelDoctorContractApi(channelId: string): BundledChannelDoctorContractApi | undefined;
export {};
