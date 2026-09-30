import { z } from "zod";
import {
  agentsApiExecutorBindingSchema,
  type AgentsApiExecutorBinding,
} from "./agentsapi-environment.js";

export type AgentsApiBinding = {
  sessionId: string;
  configFingerprint: string;
  executor?: AgentsApiExecutorBinding;
};

export const bindingSchema = z
  .object({
    sessionId: z.string().min(1),
    configFingerprint: z.string().min(1),
    executor: agentsApiExecutorBindingSchema.optional(),
  })
  .refine((row) => !row.executor || row.executor.nativeSessionId === row.sessionId);
const storedBindingSchema = z
  .object({
    sessionId: z.string().min(1).optional(),
    configFingerprint: z.string().min(1).optional(),
    executor: agentsApiExecutorBindingSchema.optional(),
    lease: z.object({ token: z.string().min(1), expiresAt: z.number().finite() }).optional(),
  })
  .refine((row) => (row.sessionId === undefined) === (row.configFingerprint === undefined))
  .refine((row) => !row.executor || row.executor.nativeSessionId === row.sessionId);
export type StoredBinding = z.infer<typeof storedBindingSchema>;

export function readRecord(raw: unknown): StoredBinding | undefined {
  const result = storedBindingSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}
