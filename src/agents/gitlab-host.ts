export type GitLabOAuthConfig = {
  issuer: string;
  clientId: string;
  redirectUri: string;
};

/** OAuth and API requests must stay on one configured HTTPS GitLab origin. */
export function normalizeGitLabIssuer(issuer: string): string {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error("GitLab issuer must be an HTTPS origin.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !url.hostname ||
    url.hostname.endsWith(".")
  ) {
    throw new Error("GitLab issuer must be an HTTPS origin.");
  }
  return url.origin;
}

export function validateGitLabOAuthConfig(config: GitLabOAuthConfig): GitLabOAuthConfig {
  const issuer = normalizeGitLabIssuer(config.issuer);
  if (typeof config.clientId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(config.clientId)) {
    throw new Error("GitLab OAuth client ID is invalid.");
  }
  let redirect: URL;
  try {
    redirect = new URL(config.redirectUri);
  } catch {
    throw new Error("GitLab OAuth redirect URI must be HTTPS.");
  }
  if (
    redirect.protocol !== "https:" ||
    !redirect.hostname ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash ||
    config.redirectUri.length > 2048
  ) {
    throw new Error("GitLab OAuth redirect URI must be HTTPS.");
  }
  return { issuer, clientId: config.clientId, redirectUri: redirect.toString() };
}
