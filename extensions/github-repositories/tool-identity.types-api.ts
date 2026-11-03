import type { GitHubIdentityPreparation, GitHubReadIdentityStarter } from "./read-identity-api.js";
import type { GitHubToolAccount } from "./tool-account-api.js";

export type SharedGitHubIdentityPreparation = GitHubIdentityPreparation & {
  assertCurrent?: () => void;
  startCurrent?: GitHubReadIdentityStarter;
  allowAnonymous?: boolean;
  allowAppInstallation?: boolean;
  requestedRepository?: string;
  allowStale?: boolean;
};

export type PersonalGitHubIdentityPreparation = {
  profileId: string;
  accountId: number;
  assertCurrent: () => void;
  /** Display facts never authorize publication or carry a child environment. */
  forDisplay?: true;
};

export type PreparedGitHubToolEnvironment = Readonly<{
  credentialScrubEnv: Readonly<Record<string, string>>;
  localIdentityEnv: Readonly<Record<string, string>>;
  /** Append after selecting local Git parameters; never replace unrelated settings. */
  localGitConfigParameters?: string;
  excludedStoreNames: readonly string[];
  /** A local process must retain the host-selected profile and author identity. */
  managedLocalIdentity: boolean;
  /** Selected credentials require the host-owned exec lifecycle, not a runtime shell overlay. */
  hostExecutionRequired?: true;
}>;

export type PreparedGitHubPublicationIdentity = Readonly<{
  source: "system-detected" | "system-configured" | "agent-override" | "personal";
  profileId?: string;
  host?: string;
  account: GitHubToolAccount;
  env: NodeJS.ProcessEnv;
  stale?: true;
  accessExpiresAtMs?: number;
}>;

export type { GitHubToolIdentityConfig } from "./config-api.js";
