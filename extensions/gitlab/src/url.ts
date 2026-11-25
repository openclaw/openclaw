export const DEFAULT_GITLAB_BASE_URL = "https://gitlab.com";

/** A normalized GitLab server origin; paths, credentials and ports other than 443 are refused. */
export function resolveGitLabOrigin(baseUrl: unknown): string {
  const raw = typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : undefined;
  const url = URL.canParse(raw ?? DEFAULT_GITLAB_BASE_URL)
    ? new URL(raw ?? DEFAULT_GITLAB_BASE_URL)
    : undefined;
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("GitLab baseUrl must be an HTTPS server address such as https://gitlab.com.");
  }
  return url.origin;
}

const PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u;

/**
 * Admit an HTTPS project URL on the configured server and normalize it to the clone URL
 * `https://host/group[/subgroup...]/project.git`. Web URLs with `/-/` routes are refused.
 */
export function parseGitLabProjectUrl(
  value: string,
  origin: string,
): { url: string; name: string; fullName: string } | undefined {
  if (!URL.canParse(value)) {
    return undefined;
  }
  const url = new URL(value);
  if (url.origin !== origin || url.username || url.password || url.search || url.hash || url.port) {
    return undefined;
  }
  const segments = url.pathname
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "")
    .split("/")
    .filter(Boolean);
  if (
    segments.length < 2 ||
    segments.length > 20 ||
    !segments.every((segment) => PATH_SEGMENT.test(segment) && !segment.endsWith(".git"))
  ) {
    return undefined;
  }
  const fullName = segments.join("/");
  return { url: `${origin}/${fullName}.git`, name: segments.at(-1)!, fullName };
}
