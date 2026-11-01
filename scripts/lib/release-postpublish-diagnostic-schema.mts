import { z } from "zod";

export const DIAGNOSTIC_MAX_PACKAGES = 256;
const diagnosticStates = z.enum([
  "unattempted",
  "skipped",
  "started",
  "success",
  "failure",
  "unknown",
]);
export const diagnosticError = z.object({
  class: z.enum([
    "registry-not-visible",
    "selector-mismatch",
    "identity-mismatch",
    "transport",
    "malformed-response",
    "command-failure",
    "evidence-write-failure",
  ]),
  status: z.number().int().min(0).max(255).nullable(),
});
export const diagnosticPackage = z.object({
  name: z
    .string()
    .max(128)
    .regex(/^@openclaw\/[a-z0-9][a-z0-9._-]*$/u),
  state: diagnosticStates,
  publication: z.enum(["unknown", "observed"]),
  error: diagnosticError.nullable(),
});
export const diagnosticStage = z.object({
  state: diagnosticStates,
  publication: z.enum(["unknown", "observed"]),
  error: diagnosticError.nullable(),
  packages: z.array(diagnosticPackage).max(DIAGNOSTIC_MAX_PACKAGES),
  packagesTruncated: z.boolean(),
});
export const diagnosticStageNames = [
  "checkout",
  "githubRelease",
  "coreNpm",
  "postpublish",
  "pluginNpm",
  "clawHub",
  "fullReleaseValidation",
  "pluginNpmRun",
  "pluginClawHubRun",
  "pluginClawHubBootstrap",
  "openclawNpm",
  "npmTelegram",
  "evidence",
  "binding",
  "assets",
] as const;

export const diagnosticChildNames = [
  "fullReleaseValidation",
  "openclawNpm",
  "pluginNpm",
  "pluginClawHub",
  "pluginClawHubBootstrap",
  "npmTelegram",
] as const;
export const diagnosticId = z
  .string()
  .max(20)
  .regex(/^[1-9][0-9]*$/u)
  .nullable();
export const diagnosticSha = z
  .string()
  .regex(/^[a-f0-9]{40}$/u)
  .nullable();
export const diagnosticRef = z
  .string()
  .max(200)
  .regex(/^(?:refs\/(?:heads|tags)\/)?[A-Za-z0-9][A-Za-z0-9._/-]*$/u)
  .nullable();
export const diagnosticOutcome = z.enum([
  "success",
  "failure",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "neutral",
  "stale",
  "unknown",
]);
export const diagnosticSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("release-postpublish-diagnostics"),
  invocationId: z.string().uuid(),
  context: z.object({
    repository: z
      .string()
      .max(200)
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
      .nullable(),
    releaseVersion: z
      .string()
      .max(80)
      .regex(/^[0-9]+(?:\.[0-9]+){2}(?:-[a-z0-9.-]+)?$/u)
      .nullable(),
    releaseTag: z
      .string()
      .max(81)
      .regex(/^v[0-9]+(?:\.[0-9]+){2}(?:-[a-z0-9.-]+)?$/u)
      .nullable(),
    npmDistTag: z.enum(["latest", "beta", "alpha", "extended-stable"]).nullable(),
    requestedSourceSha: diagnosticSha,
    toolingSha: diagnosticSha,
    suppliedToolingSha: diagnosticSha,
    suppliedToolingRef: diagnosticRef,
    parentRunId: diagnosticId,
    parentRunAttempt: diagnosticId,
    validationEvidence: z.object({
      mode: z.enum(["full-release-validation", "authorized-beta-focused-v1"]).nullable(),
      runId: diagnosticId,
      runAttempt: diagnosticId,
    }),
  }),
  selection: z.object({
    plugins: z.array(diagnosticPackage.shape.name).max(DIAGNOSTIC_MAX_PACKAGES),
    pluginsTruncated: z.boolean(),
    workflowRef: diagnosticRef,
    clawHubWorkflowRef: diagnosticRef,
  }),
  verification: diagnosticStates,
  currentStage: z.enum(diagnosticStageNames).nullable(),
  stages: z.record(z.enum(diagnosticStageNames), diagnosticStage),
  children: z.record(
    z.enum(diagnosticChildNames),
    z.object({
      suppliedRunId: diagnosticId,
      runAttempt: diagnosticId,
      producerRunAttempt: diagnosticId,
      status: z.enum([
        "queued",
        "in_progress",
        "completed",
        "waiting",
        "pending",
        "requested",
        "unknown",
      ]),
      conclusion: diagnosticOutcome,
      failedJobCount: z.number().int().min(0).max(10000).nullable(),
      readbackArtifactId: diagnosticId,
      packageArtifactId: diagnosticId,
    }),
  ),
  jobOutcomeBeforeArtifactUploads: diagnosticOutcome,
  stepOutcomes: z.object({
    coreStart: diagnosticOutcome,
    completion: diagnosticOutcome,
  }),
});
