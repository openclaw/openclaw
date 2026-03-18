import {
  AllowFromListSchema,
  buildNestedDmConfigSchema,
  DmPolicySchema,
  GroupPolicySchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";
import { MarkdownConfigSchema, ToolPolicySchema } from "../runtime-api.js";
import { buildSecretInputSchema } from "./secret-input.js";

const matrixActionSchema = z
  .object({
    reactions: z.boolean().optional(),
    messages: z.boolean().optional(),
    pins: z.boolean().optional(),
    memberInfo: z.boolean().optional(),
    channelInfo: z.boolean().optional(),
  })
  .optional();

const matrixRoomSchema = z
  .object({
    enabled: z.boolean().optional(),
    allow: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    autoReply: z.boolean().optional(),
    users: AllowFromListSchema,
    skills: z.array(z.string()).optional(),
    systemPrompt: z.string().optional(),
  })
  .optional();

export const MatrixConfigSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  defaultAccount: z.string().optional(),
  accounts: z.record(z.string(), z.unknown()).optional(),
  markdown: MarkdownConfigSchema,
  homeserver: z.string().optional(),
  userId: z.string().optional(),
  accessToken: z.string().optional(),
  password: buildSecretInputSchema().optional(),
  deviceName: z.string().optional(),
  initialSyncLimit: z.number().optional(),
  encryption: z.boolean().optional(),
  allowlistOnly: z.boolean().optional(),
  groupPolicy: GroupPolicySchema.optional(),
  replyToMode: z.enum(["off", "first", "all"]).optional(),
  threadReplies: z.enum(["off", "inbound", "always"]).optional(),
  textChunkLimit: z.number().optional(),
  chunkMode: z.enum(["length", "newline"]).optional(),
  responsePrefix: z.string().optional(),
  mediaMaxMb: z.number().optional(),
  autoJoin: z.enum(["always", "allowlist", "off"]).optional(),
  autoJoinAllowlist: AllowFromListSchema,
  groupAllowFrom: AllowFromListSchema,
  dm: buildNestedDmConfigSchema(),
  groups: z.object({}).catchall(matrixRoomSchema).optional(),
  rooms: z.object({}).catchall(matrixRoomSchema).optional(),
  actions: matrixActionSchema,
});
