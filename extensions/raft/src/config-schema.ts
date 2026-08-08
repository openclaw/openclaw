// Raft channel configuration schema.
import {
  DmConfigSchema,
  buildChannelConfigSchema,
  buildMultiAccountChannelSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";

const RaftAccountSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    profile: z.string().min(1).optional(),
  })
  .strict();

const RaftConfigSchema = buildMultiAccountChannelSchema(RaftAccountSchema);

export const raftChannelConfigSchema = buildChannelConfigSchema(RaftConfigSchema);
