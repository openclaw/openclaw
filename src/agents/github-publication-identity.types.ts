import type { GitHubToolAccount } from "./github-tool-account.js";

export type PreparedGitHubPublicationIdentity = Readonly<{
  source: "system-detected" | "system-configured" | "agent-override" | "personal";
  profileId?: string;
  account: GitHubToolAccount;
  env: NodeJS.ProcessEnv;
}>;
