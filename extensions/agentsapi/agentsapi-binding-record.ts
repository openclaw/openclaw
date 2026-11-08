import { z } from "zod";

export type AgentsApiBinding = {
  sessionId: string;
  configFingerprint: string;
};

export type LegacyAgentsApiBinding = {
  sessionId: string;
  authFingerprint: string;
};

/** Cleanup needs identity, not permission to resume under new configuration. */
export type AgentsApiCleanupBinding = Omit<AgentsApiBinding, "configFingerprint"> & {
  configFingerprint?: string;
};

export const bindingSchema = z.object({
  sessionId: z.string().min(1),
  configFingerprint: z.string().min(1),
});
const storedBindingSchema = z
  .strictObject({
    sessionId: z.string().min(1).optional(),
    configFingerprint: z.string().min(1).optional(),
    authFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    lease: z.object({ token: z.string().min(1), expiresAt: z.number().finite() }).optional(),
  })
  .refine((row) =>
    row.sessionId === undefined
      ? row.configFingerprint === undefined && row.authFingerprint === undefined
      : (row.configFingerprint === undefined) !== (row.authFingerprint === undefined),
  );
export type StoredBinding = z.infer<typeof storedBindingSchema>;

export function readRecord(raw: unknown): StoredBinding | undefined {
  // Check the raw record before parsing can strip retired ownership metadata.
  if (
    raw &&
    typeof raw === "object" &&
    ("executor" in raw || "executorControllerPluginId" in raw)
  ) {
    throw new Error(
      "Agents API managed executor bindings are no longer supported. Retire this session with the previous OpenClaw version and original controller plugin before upgrading. The saved binding has been retained.",
    );
  }
  const result = storedBindingSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}
