import { createPatchedAccountSetupAdapter, DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";

const channel = "zalo" as const;

export const zaloSetupAdapter = createPatchedAccountSetupAdapter({
  channelKey: channel,
  validateInput: ({ accountId, input }) => {
    if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
      return "ZALO_BOT_TOKEN can only be used for the default account.";
    }
    if (!input.useEnv && !input.token && !input.tokenFile) {
      return "Zalo requires token or --token-file (or --use-env).";
    }
    return null;
  },
  buildPatch: (input) =>
    input.useEnv
      ? {}
      : input.tokenFile
        ? { tokenFile: input.tokenFile }
        : input.token
          ? { botToken: input.token }
          : {},
});
