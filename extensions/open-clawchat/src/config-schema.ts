/**
 * Open-ClawChat Configuration Schema
 */

import { z } from "zod"

export const OpenClawChatConfigSchema = z.object({
  enabled: z.boolean().optional().default(true),
  serverUrl: z.string().url("Must be a valid URL"),
  webhookPort: z.number().int().min(1024).max(65535).optional().default(8790),
  agentId: z.string().optional(),
  agentName: z.string().optional().default("OpenClaw Agent"),
  rooms: z.array(z.string()).optional().default([]),
  token: z.string().optional(),
  connectionMode: z.enum(["websocket", "webhook"]).optional().default("websocket"),
  wsUrl: z.string().optional(),
  dmPolicy: z.enum(["open", "pairing", "allowlist"]).optional().default("open"),
  groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional().default("open"),
  requireMention: z.boolean().optional().default(true),
  allowFrom: z.array(z.string()).optional(),
  groupAllowFrom: z.array(z.string()).optional(),
})

export type OpenClawChatConfigInput = z.infer<typeof OpenClawChatConfigSchema>
