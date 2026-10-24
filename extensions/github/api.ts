// Public GitHub transport and preview data for core-owned project/session and
// compatibility integrations. Importing this barrel never activates the plugin.
export {
  ControlUiGitHubError,
  discardResponse,
  fetchGitHubApi,
  fetchGitHubJson,
  formatControlUiGitHubPreviewError,
  resolveGitHubApiUrls,
  GITHUB_API_ORIGIN,
  GITHUB_API_BASE_URL,
  GITHUB_GRAPHQL_URL,
  GITHUB_REQUEST_TIMEOUT_MS,
  GitHubGraphQLUnavailableError,
  githubApiCredentialCacheScope,
  isRecord,
  optionalNumber,
  readBoundedResponse,
  readGitHubGraphQLResponse,
  readGitHubJsonResponse,
  readOptionalGitHubString,
  requiredString,
  withOptionalGitHubAuth,
} from "./src/github-api.js";
export {
  loadSessionGitHubPreview,
  loadControlUiGitHubPreview,
  parseControlUiGitHubPreviewTarget,
} from "./src/preview.js";
export type { ControlUiGitHubPreviewTarget } from "./src/preview.js";
export type {
  ControlUiGitHubPreview,
  ControlUiGitHubPreviewIdentity,
} from "./src/preview-contract.js";
export { loadSessionGitHubDetail, loadGitHubDetail } from "./src/detail.js";
export { parseGitHubTarget, parseGitHubReadTarget } from "./src/targets.js";

export { searchPublicGitHubItems } from "./src/search.js";
export { parseGitHubSearchParams } from "./src/search-params.js";

export type { SessionGitHubReadIdentity } from "./src/session-reader.js";
