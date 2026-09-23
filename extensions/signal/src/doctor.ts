// Signal doctor resolves ambiguous shipped auto-mode endpoints once and persists a concrete kind.
import type { ChannelDoctorAdapter } from "openclaw/plugin-sdk/channel-contract";
import { normalizeCompatibilityConfig } from "../doctor-contract-api.js";
import { repairSignalAccountKeys } from "./account-key-repair.js";
import { migrateLegacySignalTransportConfig } from "./config-compat.js";

export const signalDoctor: ChannelDoctorAdapter = {
  normalizeCompatibilityConfig,
  cleanStaleConfig: async ({ cfg }) => {
    const { detectSignalTransport } = await import("./transport-detection.runtime.js");
    const transport = await migrateLegacySignalTransportConfig({
      cfg,
      detect: detectSignalTransport,
    });
    return {
      ...transport,
      warnings: [
        ...(repairSignalAccountKeys({ cfg: transport.config }).warnings ?? []),
        ...(transport.warnings ?? []),
      ],
    };
  },
};
