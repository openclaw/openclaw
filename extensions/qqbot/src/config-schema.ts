import {
  AllowFromListSchema,
  buildCatchallMultiAccountChannelSchema,
  buildChannelConfigSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

const AudioFormatPolicySchema = z
  .object({
    sttDirectFormats: z.array(z.string()).optional(),
    uploadDirectFormats: z.array(z.string()).optional(),
    transcodeEnabled: z.boolean().optional(),
  })
  .optional();

const QQBotAccountSchema = z.object({
  enabled: z.boolean().optional(),
  name: z.string().optional(),
  appId: z.string().optional(),
  clientSecret: buildSecretInputSchema().optional(),
  clientSecretFile: z.string().optional(),
  allowFrom: AllowFromListSchema,
  systemPrompt: z.string().optional(),
  markdownSupport: z.boolean().optional(),
  voiceDirectUploadFormats: z.array(z.string()).optional(),
  audioFormatPolicy: AudioFormatPolicySchema,
  urlDirectUpload: z.boolean().optional(),
  upgradeUrl: z.string().optional(),
  upgradeMode: z.enum(["doc", "hot-reload"]).optional(),
});

export const QQBotConfigSchema = buildCatchallMultiAccountChannelSchema(QQBotAccountSchema);
export const qqbotChannelConfigSchema = buildChannelConfigSchema(QQBotConfigSchema);
