export type GitHubIdentityPreparationPhase =
  | "repository_admission"
  | "app_installation"
  | "oauth_refresh"
  | "credential_proof"
  | "credential_read"
  | "user_verification";
export type GitHubIdentityPreparationObserver = (
  phase: GitHubIdentityPreparationPhase,
  outcome: "started" | "resolved" | "rejected",
) => void;

/** Observation never carries credential values or changes admission/settlement. */
export function observeGitHubIdentityPreparation(
  observer: GitHubIdentityPreparationObserver | undefined,
  phase: GitHubIdentityPreparationPhase,
  outcome: Parameters<GitHubIdentityPreparationObserver>[1],
) {
  try {
    observer?.(phase, outcome);
  } catch {
    // Diagnostics cannot affect credential ownership.
  }
}

export async function measureGitHubIdentityPreparation<T>(
  observer: GitHubIdentityPreparationObserver | undefined,
  phase: GitHubIdentityPreparationPhase,
  operation: () => Promise<T>,
): Promise<T> {
  observeGitHubIdentityPreparation(observer, phase, "started");
  try {
    const result = await operation();
    observeGitHubIdentityPreparation(observer, phase, "resolved");
    return result;
  } catch (error) {
    observeGitHubIdentityPreparation(observer, phase, "rejected");
    throw error;
  }
}
