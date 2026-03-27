import {
  createPatchedAccountSetupAdapter,
  createZodSetupInputValidator,
  DEFAULT_ACCOUNT_ID,
} from "openclaw/plugin-sdk/setup";
import { z } from "zod";

const channel = "zalo" as const;

const ZaloSetupInputSchema = z
  .object({
    useEnv: z.boolean().optional(),
    token: z.string().optional(),
    tokenFile: z.string().optional(),
  })
  .passthrough();

export const zaloSetupAdapter = createPatchedAccountSetupAdapter({
  channelKey: channel,
  validateInput: createZodSetupInputValidator({
    schema: ZaloSetupInputSchema,
    validate: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "ZALO_BOT_TOKEN can only be used for the default account.";
      }
      if (!input.useEnv && !input.token && !input.tokenFile) {
        return "Zalo requires token or --token-file (or --use-env).";
      }
      return null;
    },
  }),
  buildPatch: (input) =>
    input.useEnv
      ? {}
      : input.tokenFile
        ? { tokenFile: input.tokenFile }
        : input.token
          ? { botToken: input.token }
          : {},
});
