import type { ChannelDoctorConfigMutation } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createLegacyWebhookListenerDoctorContract,
  defineChannelAliasMigration,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import {
  hasConfiguredNextcloudTalkChannelState,
  listNextcloudTalkAccountIds,
  mergeNextcloudTalkAccountConfig,
} from "../configured-state.js";

const webhookContract = createLegacyWebhookListenerDoctorContract({
  channelKey: "nextcloud-talk",
  defaultHost: "0.0.0.0",
  defaultPort: 8788,
});
export const { historicalWebhookListener } = webhookContract;

// Nextcloud Talk's nested streaming schema is delivery-only ({chunkMode,
// block}); it has no preview mode, so only the delivery flat aliases are
// legal legacy input. Account merge replaces the root streaming object
// wholesale (resolveMergedAccountConfig without a streaming deep-merge), so
// migration seeds materialized account objects with inherited root settings.
const streamingAliasMigration = defineChannelAliasMigration({
  channelId: "nextcloud-talk",
  streaming: { defaultMode: "partial", deliveryOnly: true },
  accountStreamingReplacesRoot: true,
});

export const legacyConfigRules = [
  ...webhookContract.legacyConfigRules,
  ...streamingAliasMigration.legacyConfigRules,
];

export function normalizeHistoricalWebhookConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const webhook = webhookContract.normalizeCompatibilityConfig({ cfg });
  return {
    ...webhook,
    historicalWebhookAccountIds: !hasConfiguredNextcloudTalkChannelState({ cfg })
      ? []
      : listNextcloudTalkAccountIds(cfg).filter(
          (accountId) => mergeNextcloudTalkAccountConfig(cfg, accountId).enabled !== false,
        ),
  };
}

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const webhook = normalizeHistoricalWebhookConfig({ cfg });
  return {
    ...streamingAliasMigration.normalizeChannelConfig({
      cfg: webhook.config,
      changes: webhook.changes,
    }),
    historicalWebhookAccountIds: webhook.historicalWebhookAccountIds,
  };
}
