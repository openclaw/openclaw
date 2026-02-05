import { MarkdownConfigSchema, ToolPolicySchema } from "openclaw/plugin-sdk";
import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

const xmppActionSchema = z
  .object({
    reactions: z.boolean().optional(),
  })
  .optional();

const xmppRoomSchema = z
  .object({
    enabled: z.boolean().optional(),
    allow: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema.optional(),
    autoReply: z.boolean().optional(),
    users: z.array(allowFromEntry).optional(),
    skills: z.array(z.string()).optional(),
    systemPrompt: z.string().optional(),
  })
  .optional();

export const XmppConfigSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  markdown: MarkdownConfigSchema,
  jid: z.string().optional(),
  password: z.string().optional(),
  server: z.string().optional(),
  resource: z.string().optional(),
  dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
  groupPolicy: z.enum(["open", "disabled", "allowlist"]).optional(),
  allowFrom: z.array(allowFromEntry).optional(),
  groupAllowFrom: z.array(allowFromEntry).optional(),
  rooms: z.array(z.string()).optional(),
  mucRooms: z.object({}).catchall(xmppRoomSchema).optional(),
  textChunkLimit: z.number().optional(),
  mediaMaxMb: z.number().optional(),
  blockedMediaTypes: z.array(z.string()).optional(),
  actions: xmppActionSchema,
});
