import type { GitHubAppSelection } from "./github-app-installation.js";

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
