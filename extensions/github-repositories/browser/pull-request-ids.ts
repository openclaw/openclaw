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
