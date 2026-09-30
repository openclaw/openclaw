import { BlockStreamingCoalesceSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";

const matrixStreamingModeSchema = z.enum(["partial", "quiet", "progress", "off"]);

const matrixRoomStreamingSchema = z
  .object({
    mode: matrixStreamingModeSchema.optional(),
    progress: z.object({ commentary: z.boolean().optional() }).strict().optional(),
  })
  .strict();

export const retiredMatrixStreamingMessage =
  'flat or scalar streaming values are no longer supported; use streaming.* and run "openclaw doctor --fix"';

export const matrixStreamingSchema = z
  .object(
    {
      mode: matrixStreamingModeSchema.optional(),
      rooms: z
        .record(
          z
            .string()
            .regex(/^!(?:[^:]+:.+|[A-Za-z0-9_-]{43})$/, "Expected a literal Matrix room ID"),
          matrixRoomStreamingSchema,
        )
        .optional(),
      chunkMode: z.enum(["length", "newline"]).optional(),
      block: z
        .object({
          enabled: z.boolean().optional(),
          coalesce: BlockStreamingCoalesceSchema.optional(),
        })
        .strict()
        .optional(),
      progress: z
        .object({
          label: z.union([z.string(), z.literal(false)]).optional(),
          labels: z.array(z.string()).optional(),
          maxLines: z.number().int().positive().optional(),
          maxLineChars: z.number().int().positive().optional(),
          toolProgress: z.boolean().optional(),
          commentary: z.boolean().optional(),
          commandText: z.enum(["raw", "status"]).optional(),
        })
        .strict()
        .optional(),
      preview: z
        .object({
          toolProgress: z.boolean().optional(),
        })
        .strict()
        .optional(),
    },
    { error: retiredMatrixStreamingMessage },
  )
  .strict();
