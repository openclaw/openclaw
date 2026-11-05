export type RepositoryReadIdentityFacts =
  | { source: "anonymous" }
  | { source: "system-detected"; accountId: number }
  | { source: "system-configured" | "agent-override"; accountId: number; profileId: string };

/** Preserve the source worker's existing opaque key independently of object property order. */
export function repositoryWorkerIdentityKey(identity: RepositoryReadIdentityFacts): string {
  return JSON.stringify(
    identity.source === "anonymous"
      ? { source: identity.source }
      : identity.source === "system-detected"
        ? { source: identity.source, accountId: identity.accountId }
        : { source: identity.source, accountId: identity.accountId, profileId: identity.profileId },
  );
}

/** Existing native snapshots keep their content keys; only live source admission is adapted. */
export function nativeGitHubWorkerSourceBinding(identity: RepositoryReadIdentityFacts) {
  return {
    sourceId: "github-repositories/repositories",
    identityKey: repositoryWorkerIdentityKey(identity),
  };
}
