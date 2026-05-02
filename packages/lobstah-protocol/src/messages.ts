import { z } from "zod";

export const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
});

export const ChatCompletionRequestSchema = z.object({
  model: z.string(),
  messages: z.array(ChatMessageSchema),
  stream: z.boolean().optional().default(false),
  temperature: z.number().optional(),
  max_tokens: z.number().int().optional(),
  top_p: z.number().optional(),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

export const CapacityReportSchema = z.object({
  pubkey: z.string(),
  models: z.array(z.string()),
  queueDepth: z.number().int().nonnegative(),
});

export type CapacityReport = z.infer<typeof CapacityReportSchema>;

export const RECEIPT_HEADER = "x-lobstah-receipt";
export const REQUESTER_HEADER = "x-lobstah-requester";
// SSE comment prefix used to inline a signed receipt at the tail of a streamed response.
// Spec-compliant SSE clients ignore lines starting with a colon; the router intercepts these.
export const RECEIPT_SSE_PREFIX = ":lobstah-receipt";
