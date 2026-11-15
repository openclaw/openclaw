import type { AdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import type {
  GitHubIdentityPreparation,
  GitHubReadIdentityStarter,
} from "./github-read-identity.js";
import type { GitHubToolAccount } from "./github-tool-account.js";

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
  /** App execution obtains an ephemeral credential from the session grant owner. */
  appInstallationProfileId?: string;
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
  revoke?: () => Promise<void>;
}>;

/** Shared execution cannot select a person's publication credential. */
export type PreparedSharedGitHubPublicationIdentity = Omit<
  PreparedGitHubPublicationIdentity,
  "source"
> & {
  source: Exclude<PreparedGitHubPublicationIdentity["source"], "personal">;
};

/** Nonsecret execution identity captured before approval can detach from its caller. */
export type LocalGitHubAppExecution = {
  profileId: string;
  agentId: string;
  sessionId: string;
  sessionKey: string;
  operatorAuthority?: AdmittedRunOperatorAuthority;
};
