/**
 * Convos channel configuration schema
 * Used for Control UI form generation
 */

import { MarkdownConfigSchema, buildChannelConfigSchema } from "openclaw/plugin-sdk";
import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

/**
 * Zod schema for channels.convos.* configuration
 */
export const ConvosConfigSchema = z.object({
  /** Account name (optional display name) */
  name: z.string().optional(),

  /** Whether this channel is enabled */
  enabled: z.boolean().optional(),

  /** Markdown formatting overrides (tables). */
  markdown: MarkdownConfigSchema,

  /** CLI-managed identity ID (stored in ~/.convos/identities/). */
  identityId: z.string().optional(),

  /** XMTP environment: production (default) or dev. */
  env: z.enum(["production", "dev"]).optional(),

  /** Enable debug logging for this account. */
  debug: z.boolean().optional(),

  /** Sender access policy (default: pairing). Controls who can message the agent in groups. */
  dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),

  /** Allowlist of inbox IDs permitted to message the agent. */
  allowFrom: z.array(allowFromEntry).optional(),

  /** Optional allowlist for group senders. */
  groupAllowFrom: z.array(allowFromEntry).optional(),

  /** Controls how group messages are handled (default: open). */
  groupPolicy: z.enum(["open", "disabled", "allowlist"]).optional(),

  /** Allowlist of conversation IDs the agent listens in (groupPolicy "allowlist"). Include "*" to allow all. */
  groups: z.array(z.string()).optional(),

  /** Max group messages to keep as history context (0 disables). */
  historyLimit: z.number().int().min(0).optional(),

  /** Max per-sender turns to keep as history context. */
  dmHistoryLimit: z.number().int().min(0).optional(),

  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit: z.number().int().min(100).optional(),

  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode: z.enum(["length", "newline"]).optional(),

  /** Controls agent reaction behavior. */
  reactionLevel: z.enum(["off", "ack", "minimal", "extensive"]).optional(),

  /** The conversation ID where OpenClaw communicates with its owner. */
  ownerConversationId: z.string().optional(),
});

export type ConvosConfigInput = z.infer<typeof ConvosConfigSchema>;

/**
 * JSON Schema for Control UI (converted from Zod)
 */
export const convosChannelConfigSchema = buildChannelConfigSchema(ConvosConfigSchema);
