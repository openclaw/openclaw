import { defineChannelAliasMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";

// Mattermost has a preview stream mode; runtime resolves it with a "partial"
// default (resolveChannelPreviewStreamMode(merged, "partial") in accounts.ts),
// so scalar/boolean `streaming` values migrate through the mode path. Account
// merge replaces the root streaming object wholesale (resolveMergedAccountConfig
// without a streaming deep-merge), so migration seeds materialized account
// objects with the inherited root settings.
export const { legacyConfigRules, normalizeChannelConfig: normalizeCompatibilityConfig } =
  defineChannelAliasMigration({
    channelId: "mattermost",
    streaming: { defaultMode: "partial" },
    accountStreamingReplacesRoot: true,
  });
