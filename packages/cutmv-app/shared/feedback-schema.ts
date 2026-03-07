/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Music Video Cut-Down Tool
 * Proprietary software - unauthorized use prohibited
 */

import { z } from "zod";

export const FeedbackSchema = z.object({
  id: z.string(),
  loved: z.string().optional(),
  improve: z.string().optional(),
  recommend: z.enum(["yes", "maybe", "no"]).optional(),
  email: z.string().email().optional(),
  userAgent: z.string().optional(),
  timestamp: z.string(),
  sessionContext: z.object({
    totalClips: z.number().optional(),
    totalGifs: z.number().optional(),
    totalThumbnails: z.number().optional(),
    totalCanvas: z.number().optional(),
  }).optional(),
});

export const FeedbackSubmissionSchema = FeedbackSchema.omit({ 
  id: true, 
  timestamp: true 
});

export type Feedback = z.infer<typeof FeedbackSchema>;
export type FeedbackSubmission = z.infer<typeof FeedbackSubmissionSchema>;