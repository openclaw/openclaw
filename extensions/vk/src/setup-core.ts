import { createPatchedAccountSetupAdapter, DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";

export const vkSetupAdapter = createPatchedAccountSetupAdapter({
  channelKey: "vk",
  validateInput: ({ accountId, input }) => {
    if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
      return "VK_GROUP_TOKEN can only be used for the default account.";
    }
    if (!input.useEnv && !input.token && !input.tokenFile) {
      return "VK requires token or --token-file (or --use-env).";
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
