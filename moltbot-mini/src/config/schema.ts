/**
 * Configuration schema with Zod validation.
 *
 * Design principles:
 * - Strict typing with Zod
 * - Sensible defaults
 * - Validation on load
 */

import { z } from 'zod';

/**
 * Gmail configuration schema
 */
export const GmailConfigSchema = z.object({
  enabled: z.boolean().default(true),
  // Email address to monitor (your Gmail address)
  emailAddress: z.string().email().optional(),
  // Labels to monitor for incoming emails
  watchLabels: z.array(z.string()).default(['INBOX']),
  // Maximum emails to fetch per request
  maxResults: z.number().min(1).max(100).default(20),
  // Auto-reply settings
  autoReply: z.object({
    enabled: z.boolean().default(false),
    // Only reply to emails from these addresses (allowlist)
    allowFrom: z.array(z.string()).default([]),
  }).default({}),
});

/**
 * OpenAI configuration schema
 */
export const OpenAIConfigSchema = z.object({
  model: z.string().default('gpt-4o'),
  maxTokens: z.number().min(100).max(128000).default(4096),
  temperature: z.number().min(0).max(2).default(0.7),
  // System prompt for the email assistant
  systemPrompt: z.string().default(`You are a helpful email assistant. You help users:
- Read and summarize emails
- Draft replies
- Search for emails
- Organize their inbox

Be concise and professional. When drafting emails, match the tone of the original sender.`),
});

/**
 * Agent configuration schema
 */
export const AgentConfigSchema = z.object({
  // Agent name shown in responses
  name: z.string().default('Email Assistant'),
  // Maximum conversation history to keep
  maxHistoryLength: z.number().min(1).max(100).default(20),
});

/**
 * Main configuration schema
 */
export const ConfigSchema = z.object({
  gmail: GmailConfigSchema.default({}),
  openai: OpenAIConfigSchema.default({}),
  agent: AgentConfigSchema.default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type GmailConfig = z.infer<typeof GmailConfigSchema>;
export type OpenAIConfig = z.infer<typeof OpenAIConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
