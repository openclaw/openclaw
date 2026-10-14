import { buildMultiAccountChannelSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";
import { X_GUEST_TOOLS } from "./guest-tools.js";
import { MAX_X_GUEST_MENTIONS_PER_AUTHOR_PER_DAY } from "./guest-usage.js";

const XAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  configWrites: z.boolean().optional(),
  autoPublishWorkSessions: z.boolean().optional(),
  userId: z.string().regex(/^\d+$/).optional(),
  username: z
    .string()
    .regex(/^[A-Za-z0-9_]{1,15}$/)
    .optional(),
  clientId: z.string().min(1).optional(),
  clientSecret: buildSecretInputSchema().optional(),
  refreshToken: buildSecretInputSchema().optional(),
  bearerToken: buildSecretInputSchema().optional(),
  costLimits: z
    .object({
      dailyUsd: z.number().finite().nonnegative().optional(),
      monthlyUsd: z.number().finite().nonnegative().optional(),
      cycleStartDay: z.number().int().min(1).max(28).optional(),
    })
    .strict()
    .optional(),
  events: z
    .object({
      mode: z.enum(["auto", "stream", "poll"]).optional(),
      pollSeconds: z.number().int().min(15).optional(),
    })
    .strict()
    .optional(),
  allowFrom: z.array(z.string().regex(/^(?:x:)?\d+$/i)).optional(),
  verifiedFromGitHub: z
    .object({
      repo: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/)
        .optional(),
      minPermission: z.enum(["push", "maintain", "admin"]).optional(),
      refreshMinutes: z.number().int().min(15).optional(),
      token: buildSecretInputSchema().optional(),
    })
    .strict()
    .optional(),
  groupPolicy: z.enum(["allowlist", "open", "disabled"]).optional(),
  dmPolicy: z.literal("disabled").optional(),
  threadContext: z
    .object({ maxPosts: z.number().int().min(2).max(100).optional() })
    .strict()
    .optional(),
  guests: z
    .object({
      enabled: z.boolean().optional(),
      maxMentionsPerAuthorPerDay: z
        .number()
        .int()
        .min(0)
        .max(MAX_X_GUEST_MENTIONS_PER_AUTHOR_PER_DAY)
        .optional(),
      threadContextMaxPosts: z.number().int().min(2).max(100).optional(),
      tools: z
        .object({
          allow: z.array(z.enum(X_GUEST_TOOLS)).optional(),
          deny: z.array(z.string()).optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .optional(),
  replySignature: z.string().max(140).optional(),
});

export const XConfigSchema = buildMultiAccountChannelSchema(XAccountSchema, {
  accountSchema: XAccountSchema,
  accountsMode: "catchall",
});
export type XAccountConfig = z.infer<typeof XAccountSchema>;
