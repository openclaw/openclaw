import type { ChannelDoctorConfigMutation } from "mullusi/plugin-sdk/channel-contract";
import type { MullusiConfig } from "mullusi/plugin-sdk/config-runtime";
import { normalizeCompatibilityConfig as normalizeCompatibilityConfigImpl } from "./doctor.js";

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: MullusiConfig;
}): ChannelDoctorConfigMutation {
  return normalizeCompatibilityConfigImpl({ cfg });
}
