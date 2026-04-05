import { createPatchedAccountSetupAdapter } from "mullusi/plugin-sdk/setup-runtime";

const channel = "zalouser" as const;

export const zalouserSetupAdapter = createPatchedAccountSetupAdapter({
  channelKey: channel,
  validateInput: () => null,
  buildPatch: () => ({}),
});
