/** Browser-only account presentation, independent of composer and PR controls. */
export { createGitHubIdentityRenderer } from "./browser/identity.js";
export {
  createGitHubConnectionsRenderer,
  type GitHubConnectionsProps,
} from "./browser/connections.js";
export type { GitHubIdentityFacts, GitHubIdentityView } from "./browser/identity-contract.js";
export type { GitHubIdentityHost } from "./browser/identity-host.js";
