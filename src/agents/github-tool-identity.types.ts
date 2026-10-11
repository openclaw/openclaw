import type { GitHubToolAccount } from "./github-tool-account.js";

export type PreparedGitHubToolEnvironment = Readonly<{
  credentialScrubEnv: Readonly<Record<string, string>>;
  localIdentityEnv: Readonly<Record<string, string>>;
  /** Append after selecting local Git parameters; never replace unrelated settings. */
  localGitConfigParameters?: string;
  excludedStoreNames: readonly string[];
  /** A local process must retain the host-selected profile and author identity. */
  managedLocalIdentity: boolean;
}>;

export type PreparedGitHubPublicationIdentity = Readonly<{
  source: "system-detected" | "system-configured" | "agent-override" | "personal";
  profileId?: string;
  host?: string;
  account: GitHubToolAccount;
  env: NodeJS.ProcessEnv;
}>;
