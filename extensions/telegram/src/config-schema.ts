import {
  buildChannelConfigSchema,
  refineChannelDmPolicy,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";
import {
  TelegramAccountSchemaBase,
  telegramRootPolicyShape,
  validateTelegramCustomCommands,
  validateTelegramWebhookSecretRequirements,
} from "../config-schema-api.js";
import { telegramChannelConfigUiHints } from "./config-ui-hints.js";

// DM policy validation below uses each account's effective inherited allowFrom.
const TelegramAccountSchema = TelegramAccountSchemaBase.superRefine(validateTelegramCustomCommands);

export const TelegramConfigSchema = TelegramAccountSchemaBase.extend({
  ...telegramRootPolicyShape,
  accounts: z.record(z.string(), TelegramAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  refineChannelDmPolicy({ channelId: "telegram", value, ctx });
  validateTelegramCustomCommands(value, ctx);

  if (value.accounts) {
    for (const [accountId, account] of Object.entries(value.accounts)) {
      if (!account) {
        continue;
      }
      refineChannelDmPolicy({ channelId: "telegram", value, accountId, ctx });
    }
  }

  validateTelegramWebhookSecretRequirements(value, ctx);
});

export const TelegramChannelConfigSchema = buildChannelConfigSchema(TelegramConfigSchema, {
  uiHints: telegramChannelConfigUiHints,
});
