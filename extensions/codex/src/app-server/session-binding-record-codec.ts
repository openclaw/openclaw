/** Canonical persisted binding codec; safe to load before worker transaction admission. */
import { z } from "zod";
import { CODEX_PLUGIN_MARKETPLACE_NAME_PATTERN } from "./config-contracts.shared.js";
import type { CodexServiceTier } from "./protocol.js";
import { normalizeCodexServiceTier } from "./service-tier-normalization.js";

const optionalStringSchema = z.string().optional().catch(undefined);
const optionalBooleanSchema = z.boolean().optional().catch(undefined);
const optionalNonBlankStringSchema = z
  .string()
  .refine((value) => Boolean(value.trim()))
  .optional()
  .catch(undefined);
const optionalTimestampSchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)))
  .optional()
  .catch(undefined);
const pendingSupervisionBranchSchema = z
  .object({
    sourceThreadId: z.string().trim().min(1),
    connectionFingerprint: z.string().trim().min(1).optional(),
    lastTurnId: z.string().trim().min(1).optional(),
    cleanupThreadIds: z.array(z.string().trim().min(1)).max(2).optional(),
  })
  .strict()
  .superRefine((pending, context) => {
    const cleanupThreadIds = pending.cleanupThreadIds ?? [];
    if (new Set(cleanupThreadIds).size !== cleanupThreadIds.length) {
      context.addIssue({
        code: "custom",
        message: "pending supervision cleanup thread ids must be unique",
      });
    }
    if (cleanupThreadIds.includes(pending.sourceThreadId)) {
      context.addIssue({
        code: "custom",
        message: "pending supervision cleanup cannot target its source",
      });
    }
  });
const contextEngineProjectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.literal("thread_bootstrap"),
    epoch: z.string().refine((value) => Boolean(value.trim())),
    fingerprint: optionalStringSchema,
  })
  .strict();
const contextEngineSchema = z
  .object({
    schemaVersion: z.literal(1),
    engineId: z.string(),
    policyFingerprint: z.string(),
    projection: contextEngineProjectionSchema.optional().catch(undefined),
  })
  .strict();
const destructiveApprovalModeSchema = z.enum(["allow", "deny", "auto", "ask"]).optional();
// Account-connected apps are admitted without a plugin package; both entry
// shapes must round-trip or stored policy context silently drops on read.
const accountAppPolicyEntrySchema = z
  .object({
    source: z.literal("account"),
    appName: z.string(),
    allowDestructiveActions: z.boolean(),
    allowOpenWorld: z.boolean().optional(),
    destructiveApprovalMode: destructiveApprovalModeSchema.catch(undefined),
    mcpServerNames: z.array(z.string()),
  })
  .strict();
const pluginAppPolicyEntrySchema = z
  .object({
    source: z.literal("plugin").optional(),
    configKey: z.string(),
    marketplaceName: z.string().regex(CODEX_PLUGIN_MARKETPLACE_NAME_PATTERN),
    pluginName: z.string(),
    allowDestructiveActions: z.boolean(),
    allowOpenWorld: z.boolean().optional(),
    destructiveApprovalMode: destructiveApprovalModeSchema.catch(undefined),
    mcpServerNames: z.array(z.string()),
  })
  .strict();
const pluginAppPolicyContextSchema = z
  .object({
    fingerprint: z.string(),
    apps: z.record(z.string(), z.union([accountAppPolicyEntrySchema, pluginAppPolicyEntrySchema])),
    pluginAppIds: z.record(z.string(), z.array(z.string())).default({}),
  })
  .strict();
export const legacyAppPolicyEntrySchema = z.union([
  accountAppPolicyEntrySchema
    .extend({ destructiveApprovalMode: destructiveApprovalModeSchema })
    .strip(),
  pluginAppPolicyEntrySchema
    .extend({ destructiveApprovalMode: destructiveApprovalModeSchema })
    .strip(),
]);
const threadBindingSchema = z
  .object({
    threadId: z.string().refine((value) => Boolean(value.trim())),
    clientId: optionalStringSchema,
    cwd: z.string(),
    rolloutPath: optionalNonBlankStringSchema,
    // Private runtime ownership. Only the supervision catalog creates this
    // marker; public OpenClaw session metadata must never authorize user-home access.
    connectionScope: z.literal("supervision").optional(),
    supervisionSourceThreadId: z.string().trim().min(1).optional(),
    authProfileId: optionalStringSchema,
    // Empty captures no workspace instructions; absence still permits first capture.
    // Bootstrap refreshes must not mutate a captured native-thread snapshot.
    agentWorkspaceDeveloperInstructions: optionalStringSchema,
    model: optionalStringSchema,
    // Codex App Server owns selection for supervised and adopted threads. Keep
    // this marker across resumes so OpenClaw never substitutes a default or fallback.
    preserveNativeModel: z.literal(true).optional().catch(undefined),
    // Continue creates the OpenClaw Chat before native execution. This closed
    // snapshot state is materialized only inside the fully configured harness.
    pendingSupervisionBranch: pendingSupervisionBranchSchema.optional(),
    // Manual attachment records intent; only the harness can attest its native
    // tool catalog and observe a configured reload before admitting a turn.
    pendingResumeConfiguration: z.literal(true).optional(),
    modelProvider: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(1))
      .optional()
      .catch(undefined),
    // Legacy rows may contain the retired two-field permission overlay. Keep
    // parsing it so the rest of the binding survives; SessionEntry owns live policy.
    approvalPolicy: z
      .preprocess(
        (value) => (value === "on-failure" ? "on-request" : value),
        z.enum(["never", "on-request", "untrusted"]).optional(),
      )
      .catch(undefined),
    sandbox: z
      .enum(["read-only", "workspace-write", "danger-full-access"])
      .optional()
      .catch(undefined),
    serviceTier: z
      .preprocess(
        normalizeCodexServiceTier,
        z.custom<CodexServiceTier>((value) => typeof value === "string").optional(),
      )
      .optional()
      .catch(undefined),
    networkProxyProfileName: optionalStringSchema,
    networkProxyConfigFingerprint: optionalStringSchema,
    dynamicToolsFingerprint: optionalStringSchema,
    dynamicToolsContainDeferred: optionalBooleanSchema,
    webSearchThreadConfigFingerprint: optionalStringSchema,
    nativeSkillIsolationFingerprint: optionalStringSchema,
    userMcpServersFingerprint: optionalStringSchema,
    mcpServersFingerprint: optionalStringSchema,
    configuredMcpOwnershipVersion: z.literal(1).optional().catch(undefined),
    ringZeroConfigFingerprint: optionalStringSchema,
    ringZeroClientInstanceId: optionalStringSchema,
    /** Durable fact preventing a later unrestricted turn from widening this thread. */
    nativeToolPolicyRestricted: z.literal(true).optional().catch(undefined),
    nativeHookRelayGeneration: optionalNonBlankStringSchema,
    appServerRuntimeFingerprint: optionalStringSchema,
    pluginAppsFingerprint: optionalStringSchema,
    pluginAppsInputFingerprint: optionalStringSchema,
    pluginAppPolicyContext: pluginAppPolicyContextSchema.optional().catch(undefined),
    contextEngine: contextEngineSchema.optional().catch(undefined),
    environmentSelectionFingerprint: optionalStringSchema,
    conversationStartId: optionalStringSchema,
    conversationSourceTransferComplete: z.literal(true).optional().catch(undefined),
    historyCoveredThrough: optionalTimestampSchema,
    // Observed density of the last completed turn on this thread: prompt chars
    // actually sent vs provider-reported input tokens. Read by the no-engine
    // continuity cap so the next projection is sized from this session's real
    // content density instead of a fixed chars-per-token guess.
    continuityCalibration: z
      .object({
        promptChars: z.number().int().positive(),
        inputTokens: z.number().int().positive(),
      })
      .optional()
      .catch(undefined),
  })
  .superRefine((binding, context) => {
    if (binding.connectionScope === "supervision") {
      if (!binding.supervisionSourceThreadId) {
        context.addIssue({
          code: "custom",
          message: "supervision connection ownership requires its native source thread id",
        });
      }
      if (binding.preserveNativeModel !== true) {
        context.addIssue({
          code: "custom",
          message: "supervision connection ownership requires native model ownership",
        });
      }
      if (binding.conversationSourceTransferComplete !== true) {
        context.addIssue({
          code: "custom",
          message: "supervision connection ownership requires a completed source transfer",
        });
      }
      if (!binding.pendingSupervisionBranch && (!binding.model?.trim() || !binding.modelProvider)) {
        context.addIssue({
          code: "custom",
          message: "materialized supervision bindings require a native model and provider",
        });
      }
    }
    if (binding.supervisionSourceThreadId && binding.connectionScope !== "supervision") {
      context.addIssue({
        code: "custom",
        message: "a supervision source thread id requires supervision connection ownership",
      });
    }
    if (!binding.pendingSupervisionBranch) {
      return;
    }
    if (binding.threadId !== binding.pendingSupervisionBranch.sourceThreadId) {
      context.addIssue({
        code: "custom",
        message: "pending supervision source must match the provisional thread binding",
      });
    }
    if (binding.supervisionSourceThreadId !== binding.pendingSupervisionBranch.sourceThreadId) {
      context.addIssue({
        code: "custom",
        message: "pending supervision source must match its durable source identity",
      });
    }
    if (binding.preserveNativeModel !== true) {
      context.addIssue({
        code: "custom",
        message: "pending supervision bindings must defer model selection to Codex App Server",
      });
    }
    if (binding.connectionScope !== "supervision") {
      context.addIssue({
        code: "custom",
        message: "pending supervision bindings require supervision connection ownership",
      });
    }
  });

/** Durable Codex thread facts. Storage identity and schema stay outside this domain value. */
export type CodexAppServerThreadBinding = z.infer<typeof threadBindingSchema>;
/** Persisted source snapshot and orphan-cleanup state for a supervised native branch. */
export type CodexAppServerPendingSupervisionBranch = z.infer<typeof pendingSupervisionBranchSchema>;

export function matchesPendingSupervisionBranch(
  binding: CodexAppServerThreadBinding | undefined,
  expected: CodexAppServerPendingSupervisionBranch,
): boolean {
  const pending = binding?.pendingSupervisionBranch;
  const cleanup = pending?.cleanupThreadIds ?? [];
  const expectedCleanup = expected.cleanupThreadIds ?? [];
  return (
    binding?.threadId === expected.sourceThreadId &&
    pending?.sourceThreadId === expected.sourceThreadId &&
    pending.connectionFingerprint === expected.connectionFingerprint &&
    pending.lastTurnId === expected.lastTurnId &&
    cleanup.length === expectedCleanup.length &&
    cleanup.every((threadId, index) => threadId === expectedCleanup[index])
  );
}

/** Context-engine state persisted with a Codex app-server thread binding. */
export type CodexAppServerContextEngineBinding = z.infer<typeof contextEngineSchema>;
/** Context-engine projection metadata used to guard resumed native threads. */
export type CodexAppServerContextEngineProjectionBinding = z.infer<
  typeof contextEngineProjectionSchema
>;

const bindingLeaseSchema = z.object({
  token: z.string().refine((value) => Boolean(value.trim())),
  expiresAt: z.number().finite(),
});
const storedSessionIdSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1))
  .optional()
  .catch(undefined);
const storedBindingSchema = z.discriminatedUnion("state", [
  z.object({
    version: z.literal(1),
    state: z.literal("active"),
    binding: threadBindingSchema,
    sessionId: storedSessionIdSchema,
    lease: bindingLeaseSchema.optional().catch(undefined),
    // Keep unknown receipt versions opaque; ordinary binding writes must not erase them.
    nativeSubagentSubmissions: z.unknown().optional(),
    // Independent vendor facts; never widen the strict V1 follow-up receipt codec.
    nativeSubagentAssignments: z.unknown().optional(),
    nativeSubagentTaskImport: z.unknown().optional(),
  }),
  z.object({
    version: z.literal(1),
    state: z.literal("cleared"),
    sessionId: storedSessionIdSchema,
    lease: bindingLeaseSchema.optional().catch(undefined),
    retired: z.literal(true).optional().catch(undefined),
    nativeSubagentTaskImport: z.unknown().optional(),
  }),
]);

// Session-key rows survive transcript/session-id rotation. The stored physical
// id fences delayed lifecycle cleanup so an old generation cannot clear its successor.
export type StoredCodexAppServerBinding = z.infer<typeof storedBindingSchema>;

export function readStoredCodexAppServerBinding(
  value: unknown,
): StoredCodexAppServerBinding | undefined {
  const result = storedBindingSchema.safeParse(value);
  if (!result.success) {
    return undefined;
  }
  // SAFETY: Parsing validated required fields; normalization only removes optional undefined fields.
  return stripUndefinedValue(result.data) as StoredCodexAppServerBinding;
}

export function validateBindingForWrite(
  binding: CodexAppServerThreadBinding,
): CodexAppServerThreadBinding {
  const validated = readCodexAppServerThreadBinding(binding);
  if (!validated) {
    throw new Error("Invalid Codex app-server thread binding");
  }
  return stripUndefinedBinding(validated);
}

/** Parses stored or shipped sidecar data into the current domain value. */
export function readCodexAppServerThreadBinding(
  value: unknown,
): CodexAppServerThreadBinding | undefined {
  const result = threadBindingSchema.safeParse(value);
  if (!result.success) {
    return undefined;
  }
  return result.data;
}

export function stripUndefinedBinding(
  binding: CodexAppServerThreadBinding,
): CodexAppServerThreadBinding {
  // SAFETY: Callers validate the binding first; only optional undefined fields are removed.
  return stripUndefinedValue(binding) as CodexAppServerThreadBinding;
}

function stripUndefinedValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefinedValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, stripUndefinedValue(entry)]),
  );
}

export function readCodexBindingTimestamp(value: unknown): string | undefined {
  return optionalTimestampSchema.parse(value);
}
