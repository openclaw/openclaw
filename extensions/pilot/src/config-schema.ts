import {
  DmPolicySchema,
  MarkdownConfigSchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/pilot";
import { z } from "zod";

export const PilotAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    hostname: z.string().optional(),
    socketPath: z.string().optional(),
    registry: z.string().optional(),
    pilotctlPath: z.string().optional(),
    pollIntervalMs: z.number().int().min(500).max(60_000).optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.string()).optional(),
    defaultTo: z.string().optional(),
    markdown: MarkdownConfigSchema,
    blockStreaming: z.boolean().optional(),
  })
  .strict();

export const PilotAccountSchema = PilotAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.pilot.dmPolicy="open" requires channels.pilot.allowFrom to include "*"',
  });
});

export const PilotConfigSchema = PilotAccountSchemaBase.extend({
  accounts: z.record(z.string(), PilotAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.pilot.dmPolicy="open" requires channels.pilot.allowFrom to include "*"',
  });
});
