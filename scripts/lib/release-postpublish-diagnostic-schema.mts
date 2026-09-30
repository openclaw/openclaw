import { z } from "zod";

export const DIAGNOSTIC_MAX_PACKAGES = 256;
export const diagnosticStates = z.enum([
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
