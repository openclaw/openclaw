import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

const dmSchema = z
  .object({
    enabled: z.boolean().optional(),
    policy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
    allowFrom: z.array(allowFromEntry).optional(),
  })
  .optional();

export const WecomConfigSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),

  webhookPath: z.string().optional(),
  token: z.string().optional(),
  encodingAESKey: z.string().optional(),
  receiveId: z.string().optional(),

  streamPlaceholderContent: z.string().optional(),
  debounceMs: z.number().optional(),

  welcomeText: z.string().optional(),
  dm: dmSchema,

  defaultAccount: z.string().optional(),
  accounts: z
    .object({})
    .catchall(
      z.object({
        name: z.string().optional(),
        enabled: z.boolean().optional(),
        webhookPath: z.string().optional(),
        token: z.string().optional(),
        encodingAESKey: z.string().optional(),
        receiveId: z.string().optional(),
        streamPlaceholderContent: z.string().optional(),
        debounceMs: z.number().optional(),
        welcomeText: z.string().optional(),
        dm: dmSchema,
      }),
    )
    .optional(),
});
