export type PreparedGitHubToolEnvironment = Readonly<{
  credentialScrubEnv: Readonly<Record<string, string>>;
  localIdentityEnv: Readonly<Record<string, string>>;
  /** Append after selecting local Git parameters; never replace unrelated settings. */
  localGitConfigParameters?: string;
  excludedStoreNames: readonly string[];
  /** A local process must retain the host-selected profile and author identity. */
  managedLocalIdentity: boolean;
  /**
   * The saved profile id is explicit but not a managed id. Keep it unavailable:
   * do not inherit a shared profile or native credentials for authenticated GitHub work.
   */
  invalidGitHubSelection?: boolean;
}>;
