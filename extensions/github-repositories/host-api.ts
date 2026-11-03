import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { readGitHubConfig } from "./config-api.js";

export { GITHUB_PLUGIN_ID } from "./config-api.js";
export const GITHUB_PUBLIC_HOST = "github.com";
const GITHUB_PUBLIC_API_BASE_URL = "https://api.github.com";

export const CLEARED_GITHUB_CREDENTIALS = {
  GH_TOKEN: "",
  GH_ENTERPRISE_TOKEN: "",
  GITHUB_TOKEN: "",
  GITHUB_ENTERPRISE_TOKEN: "",
};

export function withGitHubToken(env: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  return {
    ...env,
    GH_TOKEN: token,
    GH_ENTERPRISE_TOKEN: token,
    GITHUB_TOKEN: undefined,
    GITHUB_ENTERPRISE_TOKEN: undefined,
  };
}

export function resolveConfiguredGitHubHost(config?: OpenClawConfig | null): string {
  const host = readGitHubConfig(config).host?.trim().toLowerCase() || GITHUB_PUBLIC_HOST;
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(host) || host.includes("..")) {
    throw new Error("plugins.entries.github-repositories.config.host must be a hostname");
  }
  return host;
}

export function resolveConfiguredGitHubApiBaseUrl(config?: OpenClawConfig | null): string {
  const raw = readGitHubConfig(config).apiBaseUrl?.trim() || GITHUB_PUBLIC_API_BASE_URL;
  const parsed = new URL(raw);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !["/", "", "/api/v3", "/api/v3/"].includes(parsed.pathname)
  ) {
    throw new Error(
      "plugins.entries.github-repositories.config.apiBaseUrl must be an HTTPS GitHub API base URL",
    );
  }
  const host = resolveConfiguredGitHubHost(config);
  const cloudApi = parsed.hostname === `api.${host}` && parsed.pathname === "/";
  const serverApi = parsed.hostname === host && ["/api/v3", "/api/v3/"].includes(parsed.pathname);
  if (!cloudApi && !serverApi) {
    throw new Error(
      "plugins.entries.github-repositories.config.apiBaseUrl must match the configured GitHub host",
    );
  }
  return parsed.origin + (parsed.pathname.startsWith("/api/v3") ? "/api/v3" : "");
}

export function githubRepositoryUrl(
  repository: string,
  host = resolveConfiguredGitHubHost(),
): string {
  return `https://${host}/${repository}.git`;
}
