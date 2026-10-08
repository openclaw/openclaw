import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveConfiguredGitHubApiBaseUrl, resolveConfiguredGitHubHost } from "./github-host.js";
export { CLEARED_GITHUB_CREDENTIALS, withGitHubToken } from "./github-host.js";

export function resolveGitHubHost(): string {
  return resolveConfiguredGitHubHost(getRuntimeConfigSnapshot());
}

export function resolveGitHubApiBaseUrl(): string {
  return resolveConfiguredGitHubApiBaseUrl(getRuntimeConfigSnapshot());
}
