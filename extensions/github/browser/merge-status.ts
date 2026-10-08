import { html, nothing } from "lit";
import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
} from "../control-ui-contract.js";
import type { GitHubPresentationHost } from "./presentation-host.js";

type GitHubMergePhase = "pending" | "enqueued" | "verifying" | "failed" | "unavailable";

export type GitHubMergeStatus = {
  phase: GitHubMergePhase;
  message: string;
};

export const GITHUB_MERGE_LABEL_KEYS: Record<GitHubMergePhase, string> = {
  pending: "chat.pullRequests.mergePending",
  enqueued: "chat.pullRequests.mergeQueued",
  verifying: "chat.pullRequests.mergeVerifying",
  failed: "chat.pullRequests.mergeFailed",
  unavailable: "chat.pullRequests.mergeUnavailable",
};

export function resolveGitHubMergeStatus(
  pullRequest: ControlUiSessionPullRequest,
  snapshotStatus: ControlUiSessionPullRequestSnapshot["status"],
  t: GitHubPresentationHost["t"],
): GitHubMergeStatus | undefined {
  const merge = pullRequest.merge;
  if (!merge || pullRequest.state === "merged" || pullRequest.state === "closed") {
    return undefined;
  }
  // Retained snapshots are not fresh merge observations. Keep uncertainty visible
  // instead of leaving a stale pending result animated indefinitely.
  if (snapshotStatus !== "ready") {
    return { phase: "unavailable", message: t("chat.pullRequests.unavailable") };
  }
  return {
    phase: merge.status === "merged" ? "verifying" : merge.status,
    message: merge.message,
  };
}

export function renderGitHubMergeStatus(
  status: GitHubMergeStatus | undefined,
  t: GitHubPresentationHost["t"],
) {
  if (!status) {
    return nothing;
  }
  return html`<div class="chat-pr__merge-detail" role="status">
    <span class="chat-pr__merge-label">${t(GITHUB_MERGE_LABEL_KEYS[status.phase])}</span>
    <span>${status.message}</span>
  </div>`;
}
