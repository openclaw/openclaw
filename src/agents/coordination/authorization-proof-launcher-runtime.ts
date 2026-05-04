import { runCoordinationAuthorizationProofLauncher } from "./authorization-proof-launcher.js";

export type CoordinationAuthorizationProofLauncherRuntimeInput = {
  authorizationPath?: string;
  jobPath?: string;
  proofAttemptId?: string;
  actualPercentCompleteOnReady?: number;
};

export function validateAuthorizationProofLauncherRuntimeInput(
  input: CoordinationAuthorizationProofLauncherRuntimeInput,
): {
  authorizationPath: string;
  jobPath: string;
  proofAttemptId: string;
  actualPercentCompleteOnReady?: number;
} {
  const authorizationPath = input.authorizationPath?.trim();
  const jobPath = input.jobPath?.trim();
  const proofAttemptId = input.proofAttemptId?.trim();

  if (!authorizationPath) {
    throw new Error("authorizationPath is required");
  }
  if (!jobPath) {
    throw new Error("jobPath is required");
  }
  if (!proofAttemptId) {
    throw new Error("proofAttemptId is required");
  }

  return {
    authorizationPath,
    jobPath,
    proofAttemptId,
    actualPercentCompleteOnReady: input.actualPercentCompleteOnReady,
  };
}

export async function runCoordinationAuthorizationProofLauncherRuntime(
  input: CoordinationAuthorizationProofLauncherRuntimeInput,
) {
  const validated = validateAuthorizationProofLauncherRuntimeInput(input);
  return runCoordinationAuthorizationProofLauncher({
    authorizationPath: validated.authorizationPath,
    jobPath: validated.jobPath,
    proofAttemptId: validated.proofAttemptId,
    actualPercentCompleteOnReady: validated.actualPercentCompleteOnReady,
  });
}
