/**
 * Setup adapter for the telegram-userbot channel.
 *
 * Handles applying account configuration (apiId, apiHash) to the
 * OpenClaw config object.
 */

import {
  applyAccountNameToChannelSection,
  DEFAULT_ACCOUNT_ID,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  type ChannelSetupAdapter,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";

const CHANNEL_KEY = "telegram-userbot";

export const telegramUserbotSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),

  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      cfg,
      channelKey: CHANNEL_KEY,
      accountId,
      name,
    }),

  applyAccountConfig: ({ cfg, accountId, input }) => {
    const namedConfig = applyAccountNameToChannelSection({
      cfg,
      channelKey: CHANNEL_KEY,
      accountId,
      name: input.name,
    });
    const next =
      accountId !== DEFAULT_ACCOUNT_ID
        ? migrateBaseNameToDefaultAccount({ cfg: namedConfig, channelKey: CHANNEL_KEY })
        : namedConfig;

    // Build the config patch from available setup input fields.
    // apiId and apiHash come via the generic `token` field for now;
    // a dedicated setup flow will parse them in TASK_13.
    const configPatch: Record<string, unknown> = {};
    if (input.token) {
      // Expect token to be a JSON string with { apiId, apiHash }
      try {
        const parsed = JSON.parse(input.token) as { apiId?: number; apiHash?: string };
        if (parsed.apiId) configPatch.apiId = parsed.apiId;
        if (parsed.apiHash) configPatch.apiHash = parsed.apiHash;
      } catch {
        // If not JSON, ignore -- interactive setup will handle this.
      }
    }

    if (accountId === DEFAULT_ACCOUNT_ID) {
      return {
        ...next,
        channels: {
          ...next.channels,
          [CHANNEL_KEY]: {
            ...next.channels?.[CHANNEL_KEY],
            enabled: true,
            ...configPatch,
          },
        },
      } as OpenClawConfig;
    }

    const channelSection =
      (next.channels?.[CHANNEL_KEY] as Record<string, unknown> | undefined) ?? {};
    const existingAccounts = (channelSection.accounts as Record<string, unknown> | undefined) ?? {};
    const existingAccount =
      (existingAccounts[accountId] as Record<string, unknown> | undefined) ?? {};

    return {
      ...next,
      channels: {
        ...next.channels,
        [CHANNEL_KEY]: {
          ...channelSection,
          enabled: true,
          accounts: {
            ...existingAccounts,
            [accountId]: {
              ...existingAccount,
              enabled: true,
              ...configPatch,
            },
          },
        },
      },
    } as OpenClawConfig;
  },
};
