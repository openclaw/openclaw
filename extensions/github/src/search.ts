import { truncateUtf16Safe } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  ControlUiGitHubError,
  fetchGitHubApi,
  GITHUB_API_ORIGIN,
  isRecord,
  readGitHubJsonResponse,
  requiredString,
  withOptionalGitHubAuth,
} from "./github-api.js";
import { assertPublicGitHubRepository, type ControlUiGitHubPreviewIdentity } from "./preview.js";
import {
  quoteGitHubSearchKeywords,
  validGitHubSearchRepository,
  type GitHubSearchParams,
} from "./search-params.js";
import { parseGitHubLinkParams } from "./targets.js";

const PAGE_SIZE = 20;
const RESULT_LIMIT = 1_000;

async function searchWithIdentity(
  params: GitHubSearchParams,
  identity: ControlUiGitHubPreviewIdentity | undefined,
  fetchImpl: typeof fetch,
) {
  const repositoryUrl = `${GITHUB_API_ORIGIN}/repos/${params.repository}`;
  const repository = await assertPublicGitHubRepository(
    repositoryUrl,
    fetchImpl,
    identity?.token,
    identity,
  );
  const canonical = requiredString(repository, "full_name");
  if (
    !validGitHubSearchRepository(canonical) ||
    typeof repository.id !== "number" ||
    !Number.isSafeInteger(repository.id) ||
    repository.id < 1
  ) {
    throw new ControlUiGitHubError(502, "GitHub returned invalid repository metadata");
  }
  // Quote each literal word; no caller text can become a qualifier or Boolean operator.
  const keywords = quoteGitHubSearchKeywords(params.query);
  const query = [
    `repo:${canonical}`,
    "is:public",
    `is:${params.kind === "pull" ? "pull-request" : "issue"}`,
    ...(params.state === "all" ? [] : [`is:${params.state}`]),
    ...(keywords ? [keywords] : []),
  ].join(" ");
  const url = new URL(`${GITHUB_API_ORIGIN}/search/issues`);
  url.search = new URLSearchParams({
    q: query,
    sort: "updated",
    order: "desc",
    per_page: String(PAGE_SIZE),
    page: String(params.page),
  }).toString();
  const value = await readGitHubJsonResponse(
    await fetchGitHubApi(
      url.href,
      fetchImpl,
      identity?.token,
      async () => {
        // A search redirect must not replace the fixed query or repository scope.
        throw new ControlUiGitHubError(502, "GitHub search returned an unexpected redirect");
      },
      identity,
      undefined,
      undefined,
      undefined,
      GITHUB_API_ORIGIN,
    ),
    1024 * 1024,
  );
  if (
    !isRecord(value) ||
    typeof value.total_count !== "number" ||
    !Number.isSafeInteger(value.total_count) ||
    value.total_count < 0 ||
    typeof value.incomplete_results !== "boolean" ||
    !Array.isArray(value.items) ||
    value.items.length > PAGE_SIZE
  ) {
    throw new ControlUiGitHubError(502, "GitHub returned an invalid search page");
  }
  const items = value.items.map((item: unknown) => {
    const parsed = isRecord(item) ? parseGitHubLinkParams({ url: item.html_url }) : null;
    if (
      !isRecord(item) ||
      !parsed ||
      parsed.target.kind === "commit" ||
      `${parsed.target.owner}/${parsed.target.repo}`.toLowerCase() !== canonical.toLowerCase() ||
      typeof item.repository_url !== "string" ||
      item.repository_url.toLowerCase() !==
        `${GITHUB_API_ORIGIN}/repos/${canonical}`.toLowerCase() ||
      item.number !== parsed.target.number ||
      (item.pull_request ? "pull" : "issue") !== parsed.target.kind ||
      parsed.target.kind !== params.kind ||
      (item.state !== "open" && item.state !== "closed") ||
      (params.state !== "all" && item.state !== params.state)
    ) {
      throw new ControlUiGitHubError(
        502,
        "GitHub search returned an item outside the requested scope",
      );
    }
    return {
      url: parsed.url,
      number: parsed.target.number,
      kind: parsed.target.kind,
      title: truncateUtf16Safe(requiredString(item, "title"), 512),
      state: item.state,
      updatedAt: requiredString(item, "updated_at"),
    };
  });
  // Visibility can change while authenticated search is pending; do not disclose that page.
  const current = await assertPublicGitHubRepository(
    `${GITHUB_API_ORIGIN}/repos/${canonical}`,
    fetchImpl,
    identity?.token,
    identity,
  );
  if (current.id !== repository.id) {
    throw new ControlUiGitHubError(404, "GitHub repository is not public or has changed");
  }
  await identity?.revalidate();
  identity?.assertSelected();
  return {
    repository: canonical,
    kind: params.kind,
    page: params.page,
    pageSize: PAGE_SIZE,
    totalCount: value.total_count,
    incomplete: value.incomplete_results,
    resultLimit: RESULT_LIMIT,
    limited: value.total_count > RESULT_LIMIT,
    nextPage:
      params.page * PAGE_SIZE < Math.min(value.total_count, RESULT_LIMIT) ? params.page + 1 : null,
    items,
  };
}

export function searchPublicGitHubItems(
  params: GitHubSearchParams,
  identity?: ControlUiGitHubPreviewIdentity,
  fetchImpl: typeof fetch = fetch,
) {
  return identity?.optionalAuth
    ? withOptionalGitHubAuth(identity.token, (token) =>
        searchWithIdentity(params, { ...identity, token }, fetchImpl),
      )
    : searchWithIdentity(params, identity, fetchImpl);
}
