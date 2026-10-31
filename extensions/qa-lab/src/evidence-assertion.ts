import { z } from "zod";
import { qaCoverageIdSchema } from "./coverage-id.js";

export const qaEvidenceCoverageSchema = z.strictObject({
  id: qaCoverageIdSchema,
  role: z.string().trim().min(1),
});

// Catalog declarations and observed bindings share one contract without making
// the catalog depend on the evidence reader that already consumes it.
export const qaEvidenceAssertionSchema = z.strictObject({
  id: z.string().trim().min(1),
  meaning: z.string().trim().min(1),
  coverage: z.array(qaEvidenceCoverageSchema),
});
