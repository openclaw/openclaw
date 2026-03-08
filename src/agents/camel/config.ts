import { z } from "zod";
import type { CaMeLConfig } from "./types.js";

const defaultPolicies = {
  trustedRecipients: [],
  requireApproval: ["exec", "message*", "gateway*"],
  noSideEffectTools: [
    "read",
    "web_search",
    "memory_search",
    "memory_get",
    "session_status",
    "image",
    "pdf",
  ],
} satisfies NonNullable<CaMeLConfig["policies"]>;

export const CaMeLConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    mode: z.enum(["strict", "permissive"]).default("strict"),
    qModel: z.string().optional(),
    policies: z
      .object({
        trustedRecipients: z.array(z.string()).default(defaultPolicies.trustedRecipients),
        requireApproval: z.array(z.string()).default(defaultPolicies.requireApproval),
        noSideEffectTools: z.array(z.string()).default(defaultPolicies.noSideEffectTools),
      })
      .default(defaultPolicies),
  })
  .default({ enabled: false, mode: "strict", policies: defaultPolicies });

export function resolveCaMeLConfig(input: unknown): CaMeLConfig {
  return CaMeLConfigSchema.parse(input);
}
