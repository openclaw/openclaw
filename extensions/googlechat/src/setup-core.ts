import {
  applyAccountNameToChannelSection,
  applySetupAccountConfigPatch,
  migrateBaseNameToDefaultAccount,
} from "../../../src/channels/plugins/setup-helpers.js";
import type { ChannelSetupAdapter } from "../../../src/channels/plugins/types.adapters.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../src/routing/session-key.js";

const channel = "googlechat" as const;

export const googlechatSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name,
    }),
  validateInput: ({ accountId, input }) => {
    if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
      return "GOOGLE_CHAT_SERVICE_ACCOUNT env vars can only be used for the default account.";
    }
    if (!input.useEnv && !input.token && !input.tokenFile) {
      return "Google Chat requires --token (service account JSON) or --token-file.";
    }
    return null;
  },
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const namedConfig = applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name: input.name,
    });
    const next =
      accountId !== DEFAULT_ACCOUNT_ID
        ? migrateBaseNameToDefaultAccount({
            cfg: namedConfig,
            channelKey: channel,
          })
        : namedConfig;
    const patch = input.useEnv
      ? {}
      : input.tokenFile
        ? { serviceAccountFile: input.tokenFile }
        : input.token
          ? { serviceAccount: input.token }
          : {};
    const audienceType = input.audienceType?.trim();
    const audience = input.audience?.trim();
    const webhookPath = input.webhookPath?.trim();
    const webhookUrl = input.webhookUrl?.trim();
    return applySetupAccountConfigPatch({
      cfg: next,
      channelKey: channel,
      accountId,
      patch: {
        ...patch,
        ...(audienceType ? { audienceType } : {}),
        ...(audience ? { audience } : {}),
        ...(webhookPath ? { webhookPath } : {}),
        ...(webhookUrl ? { webhookUrl } : {}),
      },
    });
  },
};
