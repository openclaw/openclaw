/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Music Video Cut-Down Tool
 * Proprietary software - unauthorized use prohibited
 */

import { z } from "zod";

export const SupportRequestSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  subject: z.string().min(1, "Subject is required"),
  message: z.string().min(10, "Message must be at least 10 characters"),
  userAgent: z.string().optional(),
  timestamp: z.string(),
  sessionContext: z.object({
    currentPage: z.string().optional(),
    videoId: z.string().optional(),
    errorContext: z.string().optional(),
  }).optional(),
});

export const SupportSubmissionSchema = SupportRequestSchema.omit({ 
  id: true, 
  timestamp: true 
});

export type SupportRequest = z.infer<typeof SupportRequestSchema>;
export type SupportSubmission = z.infer<typeof SupportSubmissionSchema>;