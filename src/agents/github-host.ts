const DEFAULT_GITHUB_HOST = "github.com";
const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";

function normalizeGitHubHost(value: string | undefined): string {
  const host = value?.trim().toLowerCase() || DEFAULT_GITHUB_HOST;
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(host) || host.includes("..")) {
    throw new Error("OPENCLAW_GITHUB_HOST must be a hostname");
  }
  return host;
}

function normalizeGitHubApiBaseUrl(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_GITHUB_API_BASE_URL;
  const parsed = new URL(raw);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new Error("OPENCLAW_GITHUB_API_BASE_URL must be an HTTPS origin");
  }
  return parsed.origin;
}

export function resolveGitHubHost(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeGitHubHost(env.OPENCLAW_GITHUB_HOST);
}

export function resolveGitHubApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeGitHubApiBaseUrl(env.OPENCLAW_GITHUB_API_BASE_URL);
}
