import { z } from "zod";

export type AgentsApiBinding = { sessionId: string; configFingerprint: string };

export const bindingSchema = z.object({
  sessionId: z.string().min(1),
  configFingerprint: z.string().min(1),
});
const storedBindingSchema = z
  .object({
    sessionId: z.string().min(1).optional(),
    configFingerprint: z.string().min(1).optional(),
    lease: z.object({ token: z.string().min(1), expiresAt: z.number().finite() }).optional(),
  })
  .refine((row) => (row.sessionId === undefined) === (row.configFingerprint === undefined));
export type StoredBinding = z.infer<typeof storedBindingSchema>;

export function readRecord(raw: unknown): StoredBinding | undefined {
  const result = storedBindingSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}
