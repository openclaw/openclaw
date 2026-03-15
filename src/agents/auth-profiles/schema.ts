/**
 * Zod schema for auth-profiles.json validation.
 * Mirrors types in ./types.ts for runtime validation.
 *
 * @see https://github.com/openclaw/openclaw/issues/26842
 */

import { z } from "zod";

// API key credential (e.g., Anthropic API key, OpenAI API key)
export const ApiKeyCredentialSchema = z
  .object({
    type: z.literal("api_key"),
    provider: z.string().min(1),
    key: z.string().optional(),
    email: z.string().email().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();

// Static bearer token (e.g., Claude Code OAuth token, PAT)
export const TokenCredentialSchema = z
  .object({
    type: z.literal("token"),
    provider: z.string().min(1),
    token: z.string().min(1),
    expires: z.number().optional(),
    email: z.string().email().optional(),
  })
  .strict();

// Refreshable OAuth credentials
export const OAuthCredentialSchema = z
  .object({
    type: z.literal("oauth"),
    provider: z.string().min(1),
    access: z.string().optional(),
    refresh: z.string().optional(),
    expires: z.number().optional(),
    enterpriseUrl: z.string().url().optional(),
    projectId: z.string().optional(),
    accountId: z.string().optional(),
    clientId: z.string().optional(),
    email: z.string().email().optional(),
  })
  .strict();

// Union of all credential types
export const AuthProfileCredentialSchema = z.discriminatedUnion("type", [
  ApiKeyCredentialSchema,
  TokenCredentialSchema,
  OAuthCredentialSchema,
]);

// Failure reasons for cooldown tracking
export const AuthProfileFailureReasonSchema = z.enum([
  "auth",
  "format",
  "rate_limit",
  "billing",
  "timeout",
  "model_not_found",
  "unknown",
]);

// Per-profile usage statistics
export const ProfileUsageStatsSchema = z.object({
  lastUsed: z.number().optional(),
  cooldownUntil: z.number().optional(),
  disabledUntil: z.number().optional(),
  disabledReason: AuthProfileFailureReasonSchema.optional(),
  errorCount: z.number().optional(),
  failureCounts: z.record(z.string(), z.number()).optional(),
  lastFailureAt: z.number().optional(),
});

// Main auth-profiles.json schema
export const AuthProfileStoreSchema = z.object({
  version: z.number(),
  profiles: z.record(z.string(), AuthProfileCredentialSchema),
  order: z.record(z.string(), z.array(z.string())).optional(),
  lastGood: z.record(z.string(), z.string()).optional(),
  usageStats: z.record(z.string(), ProfileUsageStatsSchema).optional(),
});

export type ValidatedAuthProfileStore = z.infer<typeof AuthProfileStoreSchema>;

/**
 * Validate auth-profiles.json content.
 * Returns parsed store on success, throws ZodError on failure.
 */
export function validateAuthProfileStore(data: unknown): ValidatedAuthProfileStore {
  return AuthProfileStoreSchema.parse(data);
}

/**
 * Safe validation that returns result object instead of throwing.
 */
export function safeValidateAuthProfileStore(data: unknown) {
  return AuthProfileStoreSchema.safeParse(data);
}
