import { z } from "zod";

const ReactionSchema = z
  .object({
    enabled: z.boolean().optional(),
    onStart: z.string().optional(),
    onSuccess: z.string().optional(),
    onFailure: z.string().optional(),
    clearOnFinish: z.boolean().optional(),
  })
  .strict();

const ZulipAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    baseUrl: z.string().optional(),
    email: z.string().optional(),
    apiKey: z.string().optional(),
    streams: z.array(z.string()).optional(),
    alwaysReply: z.boolean().optional(),
    defaultTopic: z.string().optional(),
    reactions: ReactionSchema.optional(),
    textChunkLimit: z.number().int().positive().optional(),
    mediaMaxMb: z.number().int().positive().optional(),
  })
  .strict();

export const ZulipConfigSchema = ZulipAccountSchemaBase.extend({
  accounts: z.record(z.string(), ZulipAccountSchemaBase.optional()).optional(),
}).strict();
