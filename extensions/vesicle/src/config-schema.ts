import {
  AllowFromListSchema,
  buildCatchallMultiAccountChannelSchema,
  buildChannelConfigSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "openclaw/plugin-sdk/zod";
import { buildSecretInputSchema, hasConfiguredSecretInput } from "./secret-input.js";

const vesicleNetworkSchema = z
  .object({
    /** Dangerous opt-in for trusted private/internal Vesicle deployments. */
    dangerouslyAllowPrivateNetwork: z.boolean().optional(),
  })
  .strict()
  .optional();

const vesicleAccountSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    markdown: MarkdownConfigSchema,
    serverUrl: z.string().optional(),
    authToken: buildSecretInputSchema().optional(),
    webhookPath: z.string().optional(),
    webhookSecret: buildSecretInputSchema().optional(),
    dmPolicy: DmPolicySchema.optional(),
    allowFrom: AllowFromListSchema,
    groupAllowFrom: AllowFromListSchema,
    groupPolicy: GroupPolicySchema.optional(),
    defaultTo: z.string().optional(),
    sendTimeoutMs: z.number().int().positive().optional(),
    probeTimeoutMs: z.number().int().positive().optional(),
    textChunkLimit: z.number().int().positive().optional(),
    network: vesicleNetworkSchema,
  })
  .superRefine((value, ctx) => {
    const serverUrl = value.serverUrl?.trim() ?? "";
    const authTokenConfigured = hasConfiguredSecretInput(value.authToken);
    if (serverUrl && !authTokenConfigured) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authToken"],
        message: "authToken is required when serverUrl is configured",
      });
    }

    const webhookPath = value.webhookPath?.trim() ?? "";
    const webhookSecretConfigured = hasConfiguredSecretInput(value.webhookSecret);
    if (webhookPath && !webhookSecretConfigured) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["webhookSecret"],
        message: "webhookSecret is required when webhookPath is configured",
      });
    }
  });

export const VesicleConfigSchema = buildCatchallMultiAccountChannelSchema(vesicleAccountSchema);

export const VesicleChannelConfigSchema = buildChannelConfigSchema(VesicleConfigSchema);
