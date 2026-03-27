import {
  createPatchedAccountSetupAdapter,
  createZodSetupInputValidator,
  DEFAULT_ACCOUNT_ID,
} from "openclaw/plugin-sdk/setup";
import { z } from "zod";

const channel = "googlechat" as const;

const GoogleChatSetupInputSchema = z
  .object({
    useEnv: z.boolean().optional(),
    token: z.string().optional(),
    tokenFile: z.string().optional(),
  })
  .passthrough();

export const googlechatSetupAdapter = createPatchedAccountSetupAdapter({
  channelKey: channel,
  validateInput: createZodSetupInputValidator({
    schema: GoogleChatSetupInputSchema,
    validate: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "GOOGLE_CHAT_SERVICE_ACCOUNT env vars can only be used for the default account.";
      }
      if (!input.useEnv && !input.token && !input.tokenFile) {
        return "Google Chat requires --token (service account JSON) or --token-file.";
      }
      return null;
    },
  }),
  buildPatch: (input) => {
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
    return {
      ...patch,
      ...(audienceType ? { audienceType } : {}),
      ...(audience ? { audience } : {}),
      ...(webhookPath ? { webhookPath } : {}),
      ...(webhookUrl ? { webhookUrl } : {}),
    };
  },
});
