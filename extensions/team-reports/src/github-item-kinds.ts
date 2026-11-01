import type { GithubCounts, GithubItemKind } from "./types.js";

export const GITHUB_ITEM_KINDS = {
  commit: { field: "commits", label: "Commit", plural: "commits" },
  pr_opened: { field: "prsOpened", label: "PR opened", plural: "PRs opened" },
  pr_merged: { field: "prsMerged", label: "PR merged", plural: "PRs merged" },
  pr_closed: { field: "prsClosed", label: "PR closed", plural: "PRs closed" },
  issue_opened: { field: "issuesOpened", label: "Issue opened", plural: "issues opened" },
  issue_closed: { field: "issuesClosed", label: "Issue closed", plural: "issues closed" },
  issue_comment: { field: "issueComments", label: "Issue comment", plural: "issue comments" },
  review_comment: { field: "reviewComments", label: "Review comment", plural: "review comments" },
  security_advisory: {
    field: "securityAdvisories",
    label: "Security advisory",
    plural: "security advisories",
  },
} satisfies Record<
  GithubItemKind,
  { field: Exclude<keyof GithubCounts, "total" | "repos">; label: string; plural: string }
>;
