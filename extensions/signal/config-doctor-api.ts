import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { defineChannelAliasMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { repairSignalAccountKeys } from "./src/account-key-repair.js";
import { migrateLegacySignalTransportConfigSync } from "./src/config-compat.js";
import { hasLegacySignalTransportFields } from "./src/legacy-transport.js";

// Signal's nested streaming schema is delivery-only ({chunkMode, block}); it
// has no preview mode, so only the delivery flat aliases are legal legacy
// input. Account merge replaces the root streaming object wholesale
// (resolveMergedAccountConfig without a streaming deep-merge), so migration
// seeds materialized account objects with the inherited root settings.
const streamingAliasMigration = defineChannelAliasMigration({
  channelId: "signal",
  streaming: { defaultMode: "partial", deliveryOnly: true },
  accountStreamingReplacesRoot: true,
});

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  ...streamingAliasMigration.legacyConfigRules,
  {
    path: ["channels", "signal"],
    message:
      'Signal transport config is now account-owned; run "openclaw doctor --fix" to migrate retired channels.signal transport fields.',
    match: (value) =>
      isRecord(value) && (Object.hasOwn(value, "apiMode") || hasLegacySignalTransportFields(value)),
  },
  {
    path: ["channels", "signal", "accounts"],
    message:
      'Signal transport config is now account-owned; run "openclaw doctor --fix" to migrate retired per-account transport fields.',
    match: (value) => isRecord(value) && Object.values(value).some(hasLegacySignalTransportFields),
  },
];

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const accountKeys = repairSignalAccountKeys({ cfg });
  const streaming = streamingAliasMigration.normalizeChannelConfig({ cfg: accountKeys.config });
  const transport = migrateLegacySignalTransportConfigSync(streaming.config);
  return {
    config: transport.config,
    changes: [...accountKeys.changes, ...streaming.changes, ...transport.changes],
    ...(transport.warnings?.length ? { warnings: transport.warnings } : {}),
  };
}
