import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

const MAX_SEARCH_BYTES = 512 * 1024;
const MAX_RESULTS = 10;

export type GitLabRemoteProject = {
  name: string;
  fullName: string;
  description?: string;
  cloneUrl: string;
  webUrl: string;
  defaultBranch?: string;
  private: boolean;
};

export type GitLabSearchResult = {
  credential: "configured" | "missing";
  projects: GitLabRemoteProject[];
};

function readString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

/** Map one GitLab API project into the host's remote-project search shape. */
export function toRemoteProject(value: unknown, origin: string): GitLabRemoteProject | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const field = (key: string): unknown => Reflect.get(value, key);
  const name = readString(field("path"), 100);
  const fullName = readString(field("path_with_namespace"), 200);
  const webUrl = readString(field("web_url"), 2048);
  if (!name || !fullName || !webUrl || !webUrl.startsWith(`${origin}/`)) {
    return undefined;
  }
  const description = readString(field("description"), 500);
  const defaultBranch = readString(field("default_branch"), 255);
  return {
    name,
    fullName,
    ...(description ? { description } : {}),
    // Clone through the same normalized form the repository source admits.
    cloneUrl: `${origin}/${fullName}.git`,
    webUrl,
    ...(defaultBranch ? { defaultBranch } : {}),
    private: field("visibility") !== "public",
  };
}

/** Search public projects anonymously; this stage carries no GitLab credential. */
export async function searchGitLabProjects(params: {
  origin: string;
  query: string;
  signal?: AbortSignal;
}): Promise<GitLabSearchResult> {
  const url = new URL("/api/v4/projects", params.origin);
  url.searchParams.set("search", params.query);
  url.searchParams.set("simple", "true");
  url.searchParams.set("visibility", "public");
  // Anonymous gitlab.com search is noisy; stars rank canonical projects above forks.
  url.searchParams.set("order_by", "star_count");
  url.searchParams.set("per_page", String(MAX_RESULTS));
  const host = new URL(params.origin).hostname;
  const { response, release } = await fetchWithSsrFGuard({
    url: url.href,
    requireHttps: true,
    timeoutMs: 15_000,
    maxRedirects: 0,
    capture: false,
    signal: params.signal,
    policy: { hostnameAllowlist: [host] },
    init: { credentials: "omit", headers: { Accept: "application/json" } },
  });
  try {
    if (!response.ok) {
      throw new Error(`GitLab search failed (HTTP ${response.status}). Try again later.`);
    }
    const text = await response.text();
    if (text.length > MAX_SEARCH_BYTES) {
      throw new Error("GitLab returned an oversized search result.");
    }
    const parsed: unknown = JSON.parse(text);
    const projects = (Array.isArray(parsed) ? parsed : [])
      .map((entry) => toRemoteProject(entry, params.origin))
      .filter((project): project is GitLabRemoteProject => project !== undefined)
      .slice(0, MAX_RESULTS);
    // Public search needs no account; "missing" would ask the user to connect one.
    return { credential: "configured", projects };
  } finally {
    await release();
  }
}
