import type { GitHubToolIdentityConfig } from "../config/types.tools.js";

export type GitHubAppSelection = Extract<GitHubToolIdentityConfig, { kind: "app-installation" }>;

/** Native callers share the existing host repository admission and credential capability. */
export type {
  RepositoryAdmission as GitHubRepositoryAdmissionRequest,
  RepositoryCredentialReader as GitHubCredentialReader,
} from "../plugins/repository-integration.types.js";
