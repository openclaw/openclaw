import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import * as implementation from "./github-api.runtime.js";

// The native account facade and plugin readers can load through different module graphs.
// Retain one HTTP kernel so error identity and credential-scoped quota cooldowns agree.
const transport = resolveGlobalSingleton(
  Symbol.for("openclaw.github.httpTransport.v1"),
  () => implementation,
);

export type ControlUiGitHubError = implementation.ControlUiGitHubError;
export type GitHubGraphQLUnavailableError = implementation.GitHubGraphQLUnavailableError;
export const {
  GITHUB_API_ORIGIN,
  GITHUB_API_BASE_URL,
  GITHUB_GRAPHQL_URL,
  resolveGitHubApiUrls,
  githubRestApiPath,
  GITHUB_REQUEST_TIMEOUT_MS,
  ControlUiGitHubError,
  GitHubGraphQLUnavailableError,
  formatControlUiGitHubPreviewError,
  githubApiCredentialCacheScope,
  requiredString,
  readOptionalGitHubString,
  optionalNumber,
  fetchGitHubApi,
  discardResponse,
  readBoundedResponse,
  readGitHubGraphQLResponse,
  withOptionalGitHubAuth,
  readGitHubJsonResponse,
  fetchGitHubJsonPage,
  fetchGitHubJson,
  isRecord,
} = transport;
