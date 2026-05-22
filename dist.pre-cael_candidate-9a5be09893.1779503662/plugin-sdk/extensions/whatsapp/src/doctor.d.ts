import type { ChannelDoctorAdapter, ChannelDoctorConfigMutation } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
export declare function normalizeCompatibilityConfig({ cfg, }: {
    cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation;
export declare const whatsappDoctor: ChannelDoctorAdapter;
