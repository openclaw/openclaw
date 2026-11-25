import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);

export const CallBriefSchema = z
  .object({
    task: text(2000).optional(),
    context: text(4000).optional(),
    language: text(100).optional(),
    identity: z
      .union([
        text(500),
        z
          .object({
            introduction: text(500),
            disclose: z.enum(["volunteer", "when-asked"]).optional(),
          })
          .strict(),
      ])
      .optional(),
    disclosures: z.array(text(500)).max(20).optional(),
    approvals: text(2000).optional(),
    voicemailMessage: text(1000).optional(),
    successCriteria: text(1000).optional(),
    maxDurationSeconds: z.number().int().positive().optional(),
  })
  .strict()
  .refine((brief) => JSON.stringify(brief).length <= 8000, "Call brief exceeds 8000 characters");

export type CallBrief = z.infer<typeof CallBriefSchema>;
