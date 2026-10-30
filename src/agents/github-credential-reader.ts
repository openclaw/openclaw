import type { GitHubToolIdentityConfig } from "../config/types.tools.js";

export type GitHubAppSelection = Extract<GitHubToolIdentityConfig, { kind: "app-installation" }>;

/** Admission is separate from execution bearer lookup, while retaining the same caller owner. */
export type GitHubRepositoryAdmissionRequest = {
  kind: "repository-admission";
  host: string;
  selection: GitHubAppSelection;
};
export type GitHubCredentialReader = (
  env: NodeJS.ProcessEnv,
  admission?: GitHubRepositoryAdmissionRequest,
) => Promise<string | undefined>;
