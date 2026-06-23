// iMessage Spectrum helper module supports config schema behavior.
import { AllowFromListSchema, DmPolicySchema } from "openclaw/plugin-sdk/channel-config-primitives";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";

const CatchupSchema = z
  .object({
    enabled: z.boolean().optional(),
    lookbackCount: z.number().int().min(1).max(100).optional(),
    intervalMs: z.number().int().min(5000).max(300_000).optional(),
  })
  .strict();

const HealthMonitorSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .strict();

const SpectrumCommonSchema = z
  .object({
    enabled: z.boolean().optional(),
    name: z.string().optional(),
    projectId: z.string().min(1).optional(),
    projectSecret: z.string().min(1).optional(),
    webhookSecret: z.string().min(1).optional(),
    webhookBaseUrl: z.string().min(1).optional(),
    deliveryRetryCount: z.number().int().min(1).max(10).optional(),
    deliveryRetryDelayMs: z.number().int().min(250).max(60_000).optional(),
    deliveryQueueSize: z.number().int().min(0).max(500).optional(),
    enableSessionContext: z.boolean().optional(),
    sessionContext: z.string().optional(),
    healthMonitor: HealthMonitorSchema.optional(),
    catchup: CatchupSchema.optional(),
    tunnelPort: z.number().optional(),
    allowFrom: AllowFromListSchema,
    dmPolicy: DmPolicySchema.optional(),
  })
  .strict();

export const ImessageSpectrumConfigSchema = SpectrumCommonSchema.extend({
  accounts: z.record(z.string(), SpectrumCommonSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).strict();

export const ImessageSpectrumChannelConfigSchema = buildChannelConfigSchema(
  ImessageSpectrumConfigSchema,
);
