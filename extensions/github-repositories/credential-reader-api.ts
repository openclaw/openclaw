import type { NativeGitHubRepositoryAdmissionRequest as GitHubRepositoryAdmissionRequest } from "openclaw/plugin-sdk/native-github-account-host";
import type { GitHubToolIdentityConfig } from "./config-api.js";

export type GitHubAppSelection = Extract<GitHubToolIdentityConfig, { kind: "app-installation" }>;

export type { NativeGitHubRepositoryAdmissionRequest as GitHubRepositoryAdmissionRequest } from "openclaw/plugin-sdk/native-github-account-host";
export type GitHubCredentialReader = ((
  env: NodeJS.ProcessEnv,
  admission?: GitHubRepositoryAdmissionRequest,
) => Promise<string | undefined>) & {
  admit?: () => Promise<void>;
  assertCurrent?: () => void;
};
