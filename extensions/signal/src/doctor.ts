// Signal doctor resolves ambiguous shipped auto-mode endpoints once and persists a concrete kind.
import type {
  ChannelDoctorAdapter,
  ChannelDoctorSequenceResult,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeCompatibilityConfig } from "../doctor-contract-api.js";
import { repairSignalAccountKeys } from "./account-key-repair.js";
import { listSignalAccountIds, resolveSignalAccount } from "./accounts.js";
import { migrateLegacySignalTransportConfig } from "./config-compat.js";
import {
  formatSignalDaemonDroppedEnvNotice,
  listSignalDaemonDroppedEnvHints,
} from "./daemon-env.js";

function usesManagedSignalDaemon(cfg: OpenClawConfig): boolean {
  if (!cfg.channels?.signal) {
    return false;
  }
  return listSignalAccountIds(cfg).some((accountId) => {
    try {
      const account = resolveSignalAccount({ cfg, accountId });
      return account.enabled && account.configured && account.transport.kind === "managed-native";
    } catch {
      // Invalid transport config is reported by the compatibility and config checks.
      return false;
    }
  });
}

export const signalDoctor: ChannelDoctorAdapter = {
  normalizeCompatibilityConfig,
  runConfigSequence: ({ cfg, env }) => {
    const result: ChannelDoctorSequenceResult = { changeNotes: [], warningNotes: [] };
    if (!usesManagedSignalDaemon(cfg)) {
      return result;
    }
    const names = listSignalDaemonDroppedEnvHints(env ?? process.env);
    if (names.length > 0) {
      result.warningNotes.push(`- channels.signal: ${formatSignalDaemonDroppedEnvNotice(names)}`);
    }
    return result;
  },
  cleanStaleConfig: async ({ cfg }) => {
    const { detectSignalTransport } = await import("./transport-detection.js");
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
