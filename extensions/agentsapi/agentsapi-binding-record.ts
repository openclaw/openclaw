import { z } from "zod";
import {
  agentsApiExecutorBindingSchema,
  type AgentsApiExecutorBinding,
} from "./agentsapi-executor-binding.js";

export type AgentsApiBinding = {
  sessionId: string;
  configFingerprint: string;
  executorControllerPluginId?: string;
  executor?: AgentsApiExecutorBinding;
};

export type LegacyAgentsApiBinding = {
  sessionId: string;
  authFingerprint: string;
};

/** Cleanup needs identity, not permission to resume under new configuration. */
export type AgentsApiCleanupBinding = Omit<AgentsApiBinding, "configFingerprint"> & {
  configFingerprint?: string;
};

export const bindingSchema = z
  .object({
    sessionId: z.string().min(1),
    configFingerprint: z.string().min(1),
    executorControllerPluginId: z.string().min(1).optional(),
    executor: agentsApiExecutorBindingSchema.optional(),
  })
  .refine(
    (row) =>
      !row.executor ||
      (row.executor.nativeSessionId === row.sessionId &&
        row.executorControllerPluginId !== undefined),
  );
const storedBindingSchema = z
  .strictObject({
    sessionId: z.string().min(1).optional(),
    configFingerprint: z.string().min(1).optional(),
    authFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    executorControllerPluginId: z.string().min(1).optional(),
    executor: agentsApiExecutorBindingSchema.optional(),
    lease: z.object({ token: z.string().min(1), expiresAt: z.number().finite() }).optional(),
  })
  .refine((row) =>
    row.sessionId === undefined
      ? row.configFingerprint === undefined && row.authFingerprint === undefined
      : (row.configFingerprint === undefined) !== (row.authFingerprint === undefined),
  )
  .refine((row) => !row.authFingerprint || (!row.executor && !row.executorControllerPluginId))
  .refine(
    (row) =>
      !row.executor ||
      (row.executor.nativeSessionId === row.sessionId &&
        row.executorControllerPluginId !== undefined),
  );
export type StoredBinding = z.infer<typeof storedBindingSchema>;

export function readRecord(raw: unknown): StoredBinding | undefined {
  if (
    raw &&
    typeof raw === "object" &&
    "executor" in raw &&
    raw.executor &&
    !("executorControllerPluginId" in raw)
  ) {
    throw new Error(
      "Agents API executor binding predates plugin ownership; retire this session with the previous version before upgrading",
    );
  }
  const result = storedBindingSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}
