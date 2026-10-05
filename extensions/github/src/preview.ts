import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import {
  asFiniteNumber,
  isRecord,
  readNonBlankString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { fetchPullChecks } from "./detail-checks.js";
import {
  ControlUiGitHubError,
  discardResponse,
  fetchGitHubApi,
  GITHUB_API_BASE_URL,
  githubRestApiPath,
  readBoundedResponse,
  readGitHubJsonResponse,
  requiredString,
  withOptionalGitHubAuth,
  type GitHubUpstreamRequestScope,
} from "./github-api.js";
import type { ControlUiGitHubPreview } from "./preview-contract.js";
import { githubTargetUrl, parseGitHubItemTarget, type GitHubItemTarget } from "./targets.js";

const GITHUB_AVATAR_HOST = "avatars.githubusercontent.com";
const GITHUB_AVATAR_MAX_BYTES = 256 * 1024;
const GITHUB_PREVIEW_TIMEOUT_MS = 2_000;
// One commits page bounds the extra request; the card only renders three faces,
// so deeper paging would spend quota on people it can never show.
const GITHUB_COMMITS_PAGE_SIZE = 100;
const GITHUB_COMMITS_MAX_BYTES = 1024 * 1024;
const CO_AUTHOR_FACE_LIMIT = 3;
// GitHub's noreply form is the only trailer that yields a login and an avatar
// without a lookup per person: `<accountId>+<login>@users.noreply.github.com`.
// One line-bounded name scan avoids overlapping whitespace backtracking.
const CO_AUTHOR_TRAILER =
  /^co-authored-by:[^<\r\n\u2028\u2029]*<(?<id>\d{1,12})\+(?<login>[a-z\d](?:[a-z\d-]{0,38}))@users\.noreply\.github\.com>[^\S\r\n\u2028\u2029]*$/gimu;
const SUCCESS_CACHE_MS = 60_000;
const FAILURE_CACHE_MS = 30_000;
const CACHE_LIMIT = 200;

export type ControlUiGitHubPreviewTarget = GitHubItemTarget;

/** Host-prepared read identity; the plugin never discovers or selects managed credentials. */
export type ControlUiGitHubPreviewIdentity = {
  token: string | undefined;
  cacheScope: string;
  /** Supplied only by the host after current session/repository authorization. */
  repository?: { owner: string; repo: string };
  host?: string;
  apiBaseUrl?: string;
  /** Host service/env credentials may retry a stale HTTP 401 anonymously. */
  optionalAuth?: true;
  revalidate: () => Promise<void>;
  assertSelected: () => void;
};

type CacheEntry<T> = {
  expiresAt: number;
  promise: Promise<T>;
};

const previewCache = new Map<string, CacheEntry<ControlUiGitHubPreview>>();

export const parseControlUiGitHubPreviewTarget = parseGitHubItemTarget;

function isPublicGitHubRepository(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.private === false && value.visibility === "public";
}

export function isReadableGitHubRepository(
  value: unknown,
  identity?: ControlUiGitHubPreviewIdentity,
): value is Record<string, unknown> {
  if (!identity?.repository) {
    return isPublicGitHubRepository(value);
  }
  const expected = `${identity.repository.owner}/${identity.repository.repo}`.toLowerCase();
  return Boolean(
    identity.token &&
    isRecord(value) &&
    typeof value.full_name === "string" &&
    value.full_name.toLowerCase() === expected,
  );
}

export async function assertPublicGitHubRepository(
  repositoryUrl: string,
  fetchImpl: typeof fetch,
  token?: string,
  identity?: ControlUiGitHubPreviewIdentity,
  signal?: AbortSignal | (() => GitHubUpstreamRequestScope),
): Promise<void> {
  // Stop before item reads so shared credentials cannot probe private item numbers.
  const repository = await readGitHubJsonResponse(
    await fetchGitHubApi(
      repositoryUrl,
      fetchImpl,
      token,
      undefined,
      identity,
      undefined,
      signal,
      undefined,
      identity?.apiBaseUrl ?? GITHUB_API_BASE_URL,
    ),
  );
  if (!isReadableGitHubRepository(repository, identity)) {
    throw new ControlUiGitHubError(404, "GitHub repository is not public");
  }
}

function redirectedRepositoryApiUrl(
  target: ControlUiGitHubPreviewTarget,
  url: URL,
  apiBaseUrl: string,
): string | null {
  const segments = githubRestApiPath(url, apiBaseUrl).split("/").filter(Boolean);
  const collection = target.kind === "pull" ? "pulls" : "issues";
  // The commits request redirects to the same item path plus one known suffix.
  const itemSegments = segments.at(-1) === "commits" ? segments.slice(0, -1) : segments;
  if (
    itemSegments.length === 5 &&
    itemSegments[0] === "repos" &&
    itemSegments[1] &&
    itemSegments[2] &&
    itemSegments[3] === collection &&
    /^\d+$/u.test(itemSegments[4] ?? "")
  ) {
    return `${apiBaseUrl}/repos/${itemSegments[1]}/${itemSegments[2]}`;
  }
  if (
    itemSegments.length === 4 &&
    itemSegments[0] === "repositories" &&
    /^\d+$/u.test(itemSegments[1] ?? "") &&
    itemSegments[2] === collection &&
    /^\d+$/u.test(itemSegments[3] ?? "")
  ) {
    return `${apiBaseUrl}/repositories/${itemSegments[1]}`;
  }
  return null;
}

function previewRepositoryApiUrl(
  target: ControlUiGitHubPreviewTarget,
  value: Record<string, unknown>,
): string {
  if (target.kind === "issue") {
    return requiredString(value, "repository_url");
  }
  const base = isRecord(value.base) ? value.base : {};
  const repository = isRecord(base.repo) ? base.repo : {};
  return requiredString(repository, "url");
}

export function parseControlUiGitHubPreviewResponse(
  target: ControlUiGitHubPreviewTarget,
  value: Record<string, unknown>,
): { preview: ControlUiGitHubPreview; avatarUrl?: string } {
  const user = isRecord(value.user) ? value.user : {};
  const head = isRecord(value.head) ? value.head : {};
  return {
    preview: {
      ...target,
      ...(target.kind === "pull" && readNonBlankString(head.ref)
        ? { branch: readNonBlankString(head.ref) }
        : {}),
      additions: asFiniteNumber(value.additions),
      changedFiles: asFiniteNumber(value.changed_files),
      closedAt: readNonBlankString(value.closed_at),
      comments: asFiniteNumber(value.comments),
      createdAt: requiredString(value, "created_at"),
      deletions: asFiniteNumber(value.deletions),
      draft: typeof value.draft === "boolean" ? value.draft : undefined,
      login: readNonBlankString(user.login) ?? "ghost",
      mergedAt: readNonBlankString(value.merged_at),
      state: requiredString(value, "state"),
      stateReason: readNonBlankString(value.state_reason),
      title: requiredString(value, "title"),
      updatedAt: requiredString(value, "updated_at"),
    },
    avatarUrl: readNonBlankString(user.avatar_url),
  };
}

function safeAvatarUrl(raw: string | undefined): URL | null {
  if (!raw) {
    return null;
  }
  const url = URL.parse(raw);
  const rawPathEnd = raw.search(/[?#]/u);
  const rawPath = rawPathEnd === -1 ? raw : raw.slice(0, rawPathEnd);
  if (
    !url ||
    url.protocol !== "https:" ||
    url.hostname !== GITHUB_AVATAR_HOST ||
    url.hash ||
    url.username ||
    url.password ||
    url.port ||
    rawPath.includes("..") ||
    rawPath.includes("\\") ||
    url.pathname.includes("..") ||
    url.pathname.includes("\\")
  ) {
    return null;
  }
  url.search = "";
  url.searchParams.set("s", "64");
  return url;
}

async function fetchCoAuthors(
  authorLogin: string,
  commits: unknown,
  fetchImpl: typeof fetch,
  upstream: () => GitHubUpstreamRequestScope,
): Promise<{ coAuthors: { login: string; avatarDataUrl?: string }[]; coAuthorCount: number }> {
  const empty = { coAuthors: [], coAuthorCount: 0 };
  if (!Array.isArray(commits)) {
    return empty;
  }
  const byLogin = new Map<string, { login: string; accountId: string }>();
  for (const entry of commits) {
    const commit = isRecord(entry) && isRecord(entry.commit) ? entry.commit : undefined;
    const message = readNonBlankString(commit?.message);
    if (!message) {
      continue;
    }
    for (const match of message.matchAll(CO_AUTHOR_TRAILER)) {
      const login = match.groups?.login;
      const accountId = match.groups?.id;
      if (!login || !accountId || login.toLowerCase() === authorLogin.toLowerCase()) {
        continue;
      }
      const key = login.toLowerCase();
      if (!byLogin.has(key)) {
        byLogin.set(key, { login, accountId });
      }
    }
  }
  const faces = [...byLogin.values()].slice(0, CO_AUTHOR_FACE_LIMIT);
  const coAuthors = await Promise.all(
    faces.map(async (face) => {
      const avatarDataUrl = await fetchAvatarDataUrl(
        `https://${GITHUB_AVATAR_HOST}/u/${face.accountId}`,
        fetchImpl,
        upstream,
      );
      return avatarDataUrl ? { login: face.login, avatarDataUrl } : { login: face.login };
    }),
  );
  return { coAuthors, coAuthorCount: byLogin.size };
}

async function fetchAvatarDataUrl(
  rawUrl: string | undefined,
  fetchImpl: typeof fetch,
  upstream: () => GitHubUpstreamRequestScope,
): Promise<string | undefined> {
  const url = safeAvatarUrl(rawUrl);
  if (!url) {
    return undefined;
  }
  let scope: GitHubUpstreamRequestScope | undefined;
  try {
    scope = upstream();
    const response = await fetchImpl(url, {
      headers: { Accept: "image/webp,image/png,image/jpeg,image/gif" },
      redirect: "error",
      signal: scope.signal,
    });
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (
      !response.ok ||
      !contentType ||
      !["image/gif", "image/jpeg", "image/png", "image/webp"].includes(contentType)
    ) {
      await discardResponse(response);
      return undefined;
    }
    const body = await readBoundedResponse(response, GITHUB_AVATAR_MAX_BYTES);
    return `data:${contentType};base64,${body.toString("base64")}`;
  } catch {
    return undefined;
  } finally {
    scope?.release();
  }
}

async function fetchPreview(
  target: ControlUiGitHubPreviewTarget,
  fetchImpl: typeof fetch,
  signal: () => GitHubUpstreamRequestScope,
  token?: string,
  identity?: ControlUiGitHubPreviewIdentity,
): Promise<ControlUiGitHubPreview> {
  if (
    identity?.repository &&
    (identity.repository.owner.toLowerCase() !== target.owner.toLowerCase() ||
      identity.repository.repo.toLowerCase() !== target.repo.toLowerCase())
  ) {
    throw new ControlUiGitHubError(404, "GitHub repository is outside the session");
  }
  const request = (url: string, beforeRedirect?: (url: URL) => Promise<void>) =>
    fetchGitHubApi(
      url,
      fetchImpl,
      token,
      beforeRedirect,
      identity,
      undefined,
      signal,
      undefined,
      identity?.apiBaseUrl ?? GITHUB_API_BASE_URL,
    );
  const assertPublicRepository = (url: string) =>
    assertPublicGitHubRepository(url, fetchImpl, token, identity, signal);
  const repositoryUrl = `${identity?.apiBaseUrl ?? GITHUB_API_BASE_URL}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  const itemUrl = `${repositoryUrl}/${target.kind === "pull" ? "pulls" : "issues"}/${target.number}`;
  if (token) {
    await assertPublicRepository(repositoryUrl);
  }
  // Every credentialed fetch below shares this guard: a rename or transfer can
  // redirect into a repository the token can read but the viewer may not see.
  const beforeRedirect = token
    ? async (url: URL) => {
        if (identity?.repository) {
          throw new ControlUiGitHubError(409, "GitHub repository changed; reopen the session");
        }
        const redirectedRepositoryUrl = redirectedRepositoryApiUrl(
          target,
          url,
          identity?.apiBaseUrl ?? GITHUB_API_BASE_URL,
        );
        if (!redirectedRepositoryUrl) {
          throw new ControlUiGitHubError(502, "GitHub item returned an unsafe redirect");
        }
        await assertPublicRepository(redirectedRepositoryUrl);
      }
    : undefined;
  const readItem = async (url: string, maxBytes?: number) =>
    readGitHubJsonResponse(await request(url, beforeRedirect), maxBytes);
  // Both item reads use the same public admission and redirect guard. Commits
  // are optional decoration; their failure must not discard useful metadata.
  const item = readItem(itemUrl);
  const commits =
    target.kind === "pull"
      ? readItem(
          `${itemUrl}/commits?per_page=${GITHUB_COMMITS_PAGE_SIZE}`,
          GITHUB_COMMITS_MAX_BYTES,
        ).catch(() => undefined)
      : Promise.resolve(undefined);
  const parsed = await item;
  if (!isRecord(parsed)) {
    throw new ControlUiGitHubError(502, "GitHub response was not an object");
  }
  if (token) {
    await assertPublicRepository(previewRepositoryApiUrl(target, parsed));
  }
  const { preview, avatarUrl } = parseControlUiGitHubPreviewResponse(target, parsed);
  const head = isRecord(parsed.head) ? parsed.head : {};
  const checks =
    target.kind === "pull" && parsed.state === "open"
      ? await fetchPullChecks(
          repositoryUrl,
          head.sha,
          `${githubTargetUrl(target, identity?.host)}/checks`,
          async (url) => ({
            value: await readItem(url),
            hasNextPage: false,
          }),
        )
      : undefined;
  // Both extra fetches run only after the public-repository assertions above,
  // so neither can widen what this token is allowed to read.
  // Render only after rechecking the response's public repository.
  const [avatarDataUrl, coAuthorFacts] = await Promise.all([
    fetchAvatarDataUrl(avatarUrl, fetchImpl, signal),
    commits.then((value) => fetchCoAuthors(preview.login, value, fetchImpl, signal)),
  ]);
  return {
    ...preview,
    ...(checks && checks.state !== "unavailable" && checks.total > 0
      ? { checksSummary: checks.summary }
      : {}),
    ...(avatarDataUrl ? { avatarDataUrl } : {}),
    ...(coAuthorFacts.coAuthorCount > 0
      ? { coAuthors: coAuthorFacts.coAuthors, coAuthorCount: coAuthorFacts.coAuthorCount }
      : {}),
  };
}

function cacheKey(
  target: ControlUiGitHubPreviewTarget,
  credentialScope: string,
  apiBaseUrl: string,
): string {
  return `${apiBaseUrl}:${target.kind}:${target.owner.toLowerCase()}/${target.repo.toLowerCase()}#${target.number}\0${credentialScope}`;
}

function cachePreview(key: string, entry: CacheEntry<ControlUiGitHubPreview>): void {
  previewCache.set(key, entry);
  pruneMapToMaxSize(previewCache, CACHE_LIMIT);
}

export async function loadControlUiGitHubPreview(
  target: ControlUiGitHubPreviewTarget,
  identity?: ControlUiGitHubPreviewIdentity,
  fetchImpl: typeof fetch = fetch,
  refresh = false,
): Promise<ControlUiGitHubPreview> {
  await identity?.revalidate();
  identity?.assertSelected();
  const { token, cacheScope } = identity ?? { token: undefined, cacheScope: "anonymous" };
  const key = cacheKey(target, cacheScope, identity?.apiBaseUrl ?? GITHUB_API_BASE_URL);
  const now = Date.now();
  let entry = previewCache.get(key);
  if (entry && (refresh || entry.expiresAt <= now)) {
    previewCache.delete(key);
    entry = undefined;
  }
  const joined = entry !== undefined;
  if (entry) {
    previewCache.delete(key);
    previewCache.set(key, entry);
  } else {
    // One upstream budget includes redirects, optional-auth retries and decoration;
    // a slow avatar or commits page must not add another full request timeout.
    // Charge overlapping transports/bodies once; admission waits without upstream work are separate.
    let usedMs = 0;
    let activeRequests = 0;
    let activeSince = 0;
    const signal = (): GitHubUpstreamRequestScope => {
      const startedAt = Date.now();
      const activeMs = activeRequests > 0 ? Math.max(0, startedAt - activeSince) : 0;
      const remainingMs = GITHUB_PREVIEW_TIMEOUT_MS - usedMs - activeMs;
      if (remainingMs <= 0) {
        throw new DOMException("GitHub request timed out", "TimeoutError");
      }
      if (activeRequests++ === 0) {
        activeSince = startedAt;
      }
      let released = false;
      return {
        signal: AbortSignal.timeout(remainingMs),
        release: () => {
          if (!released) {
            released = true;
            if (--activeRequests === 0) {
              usedMs += Math.max(0, Date.now() - activeSince);
            }
          }
        },
      };
    };
    const request =
      identity && !identity.optionalAuth
        ? fetchPreview(target, fetchImpl, signal, token, identity)
        : withOptionalGitHubAuth(token, (requestToken) =>
            fetchPreview(target, fetchImpl, signal, requestToken, identity),
          );
    const pending: CacheEntry<ControlUiGitHubPreview> = {
      expiresAt: now + SUCCESS_CACHE_MS,
      promise: request.then(
        (preview) => {
          pending.expiresAt = Date.now() + SUCCESS_CACHE_MS;
          return preview;
        },
        (error: unknown) => {
          // Lifecycle failures belong to this caller; only upstream failures
          // may suppress later requests from other readers of the credential.
          if (previewCache.get(key) === pending) {
            if (error instanceof ControlUiGitHubError) {
              pending.expiresAt = Date.now() + FAILURE_CACHE_MS;
            } else {
              previewCache.delete(key);
            }
          }
          throw error;
        },
      ),
    };
    entry = pending;
    cachePreview(key, entry);
  }
  const preview = await entry.promise.catch((error: unknown) => {
    // Only the initiating reader authorizes dispatch. If it loses authority,
    // followers retry with their own live identity instead of inheriting failure.
    if (joined && identity && !(error instanceof ControlUiGitHubError)) {
      return loadControlUiGitHubPreview(target, identity, fetchImpl);
    }
    throw error;
  });
  // Transport is credential-scoped, but every reader must still hold its
  // current identity before cached or newly fetched metadata is delivered.
  await identity?.revalidate();
  identity?.assertSelected();
  return preview;
}
