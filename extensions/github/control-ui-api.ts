/** Browser-only GitHub presentation. Importing it never starts subscriptions or mutations. */
export {
  createGitHubPullRequestRenderer,
  type GitHubPullRequestsProps,
} from "./browser/pull-requests.js";
export { createGitHubPublicationRenderer } from "./browser/publication.js";
export { createGitHubCiAutomationRenderer } from "./browser/ci-automation.js";
export {
  chatPullRequestId,
  chatBranchId,
  createGitHubPullRequestDismissals,
} from "./browser/pull-request-dismissals.js";
export type { GitHubPublicationOptions, GitHubPublicationView } from "./control-ui-contract.js";
export type { GitHubPresentationHost } from "./browser/presentation-host.js";
export { createGitHubCiDetailsRenderer, GITHUB_CHECK_ORDER } from "./browser/ci-details.js";
