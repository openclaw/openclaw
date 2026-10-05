import type { OpenClawConfig } from "../config/types.openclaw.js";

export const GITHUB_PUBLIC_HOST = "github.com";
export const GITHUB_PUBLIC_API_BASE_URL = "https://api.github.com";

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
  const host = config?.gateway?.github?.host?.trim().toLowerCase() || GITHUB_PUBLIC_HOST;
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(host) || host.includes("..")) {
    throw new Error("gateway.github.host must be a hostname");
  }
  return host;
}

export function resolveConfiguredGitHubApiBaseUrl(config?: OpenClawConfig | null): string {
  const raw = config?.gateway?.github?.apiBaseUrl?.trim() || GITHUB_PUBLIC_API_BASE_URL;
  const parsed = new URL(raw);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !["/", "", "/api/v3", "/api/v3/"].includes(parsed.pathname)
  ) {
    throw new Error("gateway.github.apiBaseUrl must be an HTTPS GitHub API base URL");
  }
  return parsed.origin + (parsed.pathname.startsWith("/api/v3") ? "/api/v3" : "");
}

export function githubRepositoryUrl(
  repository: string,
  host = resolveConfiguredGitHubHost(),
): string {
  return `https://${host}/${repository}.git`;
}

export function isGitHubCloudHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === GITHUB_PUBLIC_HOST || normalized.endsWith(".ghe.com");
}
