import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
} from "@openclaw/gateway-protocol";

export function chatPullRequestId(
  pullRequest: Pick<ControlUiSessionPullRequest, "owner" | "repo" | "number">,
): string {
  return `${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`.toLowerCase();
}

// Shares the per-session dismissal store with PR ids; `@` keeps the namespaces apart.
// GitHub owner/repo names are case-insensitive, but Git branch names are not.
export function chatBranchId(branch: ControlUiSessionBranch): string {
  return `${branch.owner}/${branch.repo}`.toLowerCase() + `@${branch.branch}`;
}

/** A retained publication receipt names a PR through its path, including supported subviews. */
export function publicationPullRequestCoordinates(url: URL) {
  const match =
    /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d{0,9})(?:\/(?:files|checks|commits(?:\/[a-fA-F\d]{7,40})?))?\/?$/u.exec(
      url.pathname,
    );
  if (!match) {
    return null;
  }
  try {
    const owner = decodeURIComponent(match[1]!);
    const repo = decodeURIComponent(match[2]!);
    return /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner) &&
      /^[a-z\d._-]{1,100}$/i.test(repo) &&
      !/^\.{1,2}$|\.(?:git|atom)$/i.test(repo)
      ? { kind: "pull" as const, owner, repo, number: Number(match[3]) }
      : null;
  } catch {
    return null;
  }
}
