import { z } from "zod";

export const AniConfigSchema = z.object({
  enabled: z.boolean().optional(),
  name: z.string().optional(),
  serverUrl: z.string().optional(),
  apiKey: z.string().optional(),
  entityId: z.number().optional(),
  dm: z
    .object({
      policy: z.enum(["open", "disabled"]).optional(),
    })
    .optional(),
  textChunkLimit: z.number().optional(),
});
