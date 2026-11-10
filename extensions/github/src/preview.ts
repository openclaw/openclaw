import { createStaleWhileRevalidateCache } from "openclaw/plugin-sdk/collection-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  asFiniteNumber,
  isRecord,
  readNonBlankString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";
import {
  ControlUiGitHubError,
  discardResponse,
  fetchGitHubJsonPage,
  GITHUB_API_ORIGIN,
  githubApiCredentialCacheScope,
  githubRestApiPath,
  readBoundedResponse,
  requiredString,
  withOptionalGitHubAuth,
} from "./github-api.js";
import type { ControlUiGitHubPreview, ControlUiGitHubPreviewIdentity } from "./preview-contract.js";
import {
  assertSessionGitHubTarget,
  assertSessionRepositoryUrl,
  readSessionGitHubRepository,
  rejectSessionGitHubRedirect,
  type SessionGitHubReadIdentity,
} from "./session-reader.js";
import { parseGitHubTarget, type GitHubTarget } from "./targets.js";

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
// Avatars can change without changing the item or commit ETag.
const DECORATION_CACHE_MS = 5 * 60_000;
const FAILURE_CACHE_MS = 30_000;
const CACHE_LIMIT = 200;
const log = createSubsystemLogger("github/preview");

export type ControlUiGitHubPreviewTarget = GitHubTarget;

const previewCaches = new WeakMap<
  typeof fetch,
  ReturnType<typeof createStaleWhileRevalidateCache<ControlUiGitHubPreview>>
>();

// Public avatar bytes carry no repository or credential state. Share them across
// items and identities, but keep injected transports in their own API environment.
const avatarCaches = new WeakMap<
  typeof fetch,
  ReturnType<typeof createStaleWhileRevalidateCache<string | undefined>>
>();

export const parseControlUiGitHubPreviewTarget = parseGitHubTarget;

export function isPublicGitHubRepository(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.private === false && value.visibility === "public";
}

export async function assertPublicGitHubRepository(
  repositoryUrl: string,
  fetchImpl: typeof fetch,
  token?: string,
  identity?: ControlUiGitHubPreviewIdentity,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  // Stop before item reads so shared credentials cannot probe private item numbers.
  const { value: repository } = await fetchGitHubJsonPage(repositoryUrl, fetchImpl, token, {
    identity,
    signal,
    apiBaseUrl: GITHUB_API_ORIGIN,
  });
  if (!isPublicGitHubRepository(repository)) {
    throw new ControlUiGitHubError(404, "GitHub repository is not public");
  }
  return repository;
}

function redirectedRepositoryApiUrl(
  target: ControlUiGitHubPreviewTarget,
  url: URL,
  apiBaseUrl = GITHUB_API_ORIGIN,
): string | null {
  const segments = githubRestApiPath(url, apiBaseUrl).split("/").filter(Boolean);
  const collection =
    target.kind === "commit" ? "commits" : target.kind === "pull" ? "pulls" : "issues";
  const validId = (id: string) =>
    target.kind === "commit" ? /^[a-f\d]{7,40}$/iu.test(id) : /^\d+$/u.test(id);
  // The commits request redirects to the same item path plus one known suffix.
  const itemSegments = segments.at(-1) === "commits" ? segments.slice(0, -1) : segments;
  if (
    itemSegments.length === 5 &&
    itemSegments[0] === "repos" &&
    itemSegments[1] &&
    itemSegments[2] &&
    itemSegments[3] === collection &&
    validId(itemSegments[4] ?? "")
  ) {
    return `${apiBaseUrl}/repos/${itemSegments[1]}/${itemSegments[2]}`;
  }
  if (
    itemSegments.length === 4 &&
    itemSegments[0] === "repositories" &&
    /^\d+$/u.test(itemSegments[1] ?? "") &&
    itemSegments[2] === collection &&
    validId(itemSegments[3] ?? "")
  ) {
    return `${apiBaseUrl}/repositories/${itemSegments[1]}`;
  }
  return null;
}

function previewRepositoryApiUrl(
  target: ControlUiGitHubPreviewTarget,
  value: Record<string, unknown>,
  apiBaseUrl: string,
): string {
  if (target.kind === "commit") {
    const repository = redirectedRepositoryApiUrl(
      target,
      new URL(requiredString(value, "url")),
      apiBaseUrl,
    );
    if (!repository) {
      throw new ControlUiGitHubError(502, "GitHub commit returned an invalid repository");
    }
    return repository;
  }
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
  if (target.kind === "commit") {
    const sha = requiredString(value, "sha");
    if (!/^[a-f\d]{40}$/iu.test(sha) || !sha.toLowerCase().startsWith(target.sha)) {
      throw new ControlUiGitHubError(502, "GitHub commit returned a different revision");
    }
    const commit = isRecord(value.commit) ? value.commit : {};
    const author = isRecord(value.author) ? value.author : {};
    const authored = isRecord(commit.author) ? commit.author : {};
    const stats = isRecord(value.stats) ? value.stats : {};
    const createdAt = requiredString(authored, "date");
    return {
      preview: {
        ...target,
        title: requiredString(commit, "message").split("\n", 1)[0]!,
        login: readNonBlankString(author.login) ?? "ghost",
        createdAt,
        updatedAt: createdAt,
        state: "committed",
        additions: asFiniteNumber(stats.additions),
        deletions: asFiniteNumber(stats.deletions),
        comments: asFiniteNumber(commit.comment_count),
      },
      avatarUrl: readNonBlankString(author.avatar_url),
    };
  }
  const user = isRecord(value.user) ? value.user : {};
  return {
    preview: {
      ...target,
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

async function fetchAvatarDataUrl(
  rawUrl: string | undefined,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<string | undefined> {
  const url = safeAvatarUrl(rawUrl);
  if (!url) {
    return undefined;
  }
  try {
    let cache = avatarCaches.get(fetchImpl);
    if (!cache) {
      cache = createStaleWhileRevalidateCache<string | undefined>({
        maxEntries: CACHE_LIMIT,
        ttlMs: DECORATION_CACHE_MS,
        cacheable: (value) => value !== undefined,
      });
      avatarCaches.set(fetchImpl, cache);
    }
    const { value } = await racePromiseWithAbortSignal(
      cache.read(url.href, async () => {
        const response = await fetchImpl(url, {
          headers: { Accept: "image/webp,image/png,image/jpeg,image/gif" },
          redirect: "error",
          signal: AbortSignal.timeout(GITHUB_PREVIEW_TIMEOUT_MS),
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
      }),
      signal,
    );
    return value;
  } catch {
    return undefined;
  }
}

async function fetchPreview(
  target: ControlUiGitHubPreviewTarget,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  token?: string,
  identity?: ControlUiGitHubPreviewIdentity,
  session?: SessionGitHubReadIdentity,
): Promise<ControlUiGitHubPreview> {
  const apiBaseUrl = session?.apiBaseUrl ?? GITHUB_API_ORIGIN;
  const startedAt = performance.now();
  const assertRepository = (url: string) => {
    if (session) {
      assertSessionRepositoryUrl(url, session);
      return readSessionGitHubRepository(session, fetchImpl, signal);
    }
    return assertPublicGitHubRepository(url, fetchImpl, token, identity, signal);
  };
  const repositoryUrl = `${apiBaseUrl}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  const collection =
    target.kind === "commit" ? "commits" : target.kind === "pull" ? "pulls" : "issues";
  const id = target.kind === "commit" ? target.sha : target.number;
  // Commit metadata includes totals even when the unused file list is bounded to one.
  const itemUrl =
    repositoryUrl + "/" + collection + "/" + id + (target.kind === "commit" ? "?per_page=1" : "");
  if (token) {
    await assertRepository(repositoryUrl);
  }
  // Every credentialed fetch below shares this guard: a rename or transfer can
  // redirect into a repository the token can read but the viewer may not see.
  const beforeRedirect = session
    ? rejectSessionGitHubRedirect
    : token
      ? async (url: URL) => {
          const redirectedRepositoryUrl = redirectedRepositoryApiUrl(target, url);
          if (!redirectedRepositoryUrl) {
            throw new ControlUiGitHubError(502, "GitHub item returned an unsafe redirect");
          }
          await assertRepository(redirectedRepositoryUrl);
        }
      : undefined;
  const readItem = async (url: string, maxBytes?: number) => {
    const { value } = await fetchGitHubJsonPage(url, fetchImpl, token, {
      beforeRedirect,
      identity,
      signal,
      apiBaseUrl,
      maxBytes,
    });
    return value;
  };
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
  const metadataAt = performance.now();
  const { preview, avatarUrl } = parseControlUiGitHubPreviewResponse(target, parsed);
  const renderedAt = performance.now();
  // Anonymous decoration can overlap visibility validation; delivery still awaits both.
  const [avatarDataUrl, coAuthorFacts] = await Promise.all([
    fetchAvatarDataUrl(avatarUrl, fetchImpl, signal),
    commits.then(async (entries) => {
      const value = target.kind === "commit" ? [parsed] : entries;
      const authorLogin = preview.login;
      const empty = { coAuthors: [], coAuthorCount: 0 };
      if (!Array.isArray(value)) {
        return empty;
      }
      const byLogin = new Map<string, { login: string; accountId: string }>();
      for (const entry of value) {
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
          const coAuthorAvatarDataUrl = await fetchAvatarDataUrl(
            `https://${GITHUB_AVATAR_HOST}/u/${face.accountId}`,
            fetchImpl,
            signal,
          );
          return coAuthorAvatarDataUrl
            ? { login: face.login, avatarDataUrl: coAuthorAvatarDataUrl }
            : { login: face.login };
        }),
      );
      return { coAuthors, coAuthorCount: byLogin.size };
    }),
    session
      ? assertSessionRepositoryUrl(previewRepositoryApiUrl(target, parsed, apiBaseUrl), session)
      : token && assertRepository(previewRepositoryApiUrl(target, parsed, apiBaseUrl)),
  ]);
  const finishedAt = performance.now();
  if (finishedAt - startedAt >= 500) {
    log.info("Slow GitHub preview load", {
      metadataMs: Math.round(metadataAt - startedAt),
      renderMs: Math.round(renderedAt - metadataAt),
      decorationMs: Math.round(finishedAt - renderedAt),
    });
  }
  return {
    ...preview,
    ...(avatarDataUrl ? { avatarDataUrl } : {}),
    ...(coAuthorFacts.coAuthorCount > 0
      ? { coAuthors: coAuthorFacts.coAuthors, coAuthorCount: coAuthorFacts.coAuthorCount }
      : {}),
  };
}

function cacheKey(target: ControlUiGitHubPreviewTarget, credentialScope: string): string {
  return `${target.kind}:${target.owner.toLowerCase()}/${target.repo.toLowerCase()}#${target.kind === "commit" ? target.sha : target.number}\0${credentialScope}`;
}

export async function loadControlUiGitHubPreview(
  target: ControlUiGitHubPreviewTarget,
  identity?: ControlUiGitHubPreviewIdentity,
  fetchImpl: typeof fetch = fetch,
  refresh = false,
): Promise<ControlUiGitHubPreview> {
  const startedAt = performance.now();
  // Cache lookup has no external effect. Dispatch and delivery revalidate live credentials.
  identity?.assertSelected();
  const { token, cacheScope } = identity ?? { token: undefined, cacheScope: "anonymous" };
  const key = cacheKey(target, `${cacheScope}\0${githubApiCredentialCacheScope(token)}`);
  const previewCache =
    previewCaches.get(fetchImpl) ??
    createStaleWhileRevalidateCache<ControlUiGitHubPreview>({
      maxEntries: CACHE_LIMIT,
      ttlMs: SUCCESS_CACHE_MS,
      errorTtlMs: (error) => (error instanceof ControlUiGitHubError ? FAILURE_CACHE_MS : 0),
    });
  previewCaches.set(fetchImpl, previewCache);
  const result = await previewCache.read(
    key,
    () => {
      // Refreshes retain credential checks before every dispatch, including redirects.
      const signal = AbortSignal.timeout(GITHUB_PREVIEW_TIMEOUT_MS);
      return identity && !identity.optionalAuth
        ? fetchPreview(target, fetchImpl, signal, token, identity)
        : withOptionalGitHubAuth(token, (requestToken) =>
            fetchPreview(target, fetchImpl, signal, requestToken, identity),
          );
    },
    { refresh },
  );
  const loadedAt = performance.now();
  // Transport is credential-scoped, but every reader must still hold its
  // current identity before cached or newly fetched metadata is delivered.
  await identity?.revalidate();
  identity?.assertSelected();
  const deliveredAt = performance.now();
  if (deliveredAt - startedAt >= 500) {
    log.info("Slow GitHub preview read", {
      cacheWaitMs: Math.round(loadedAt - startedAt),
      deliveryAuthMs: Math.round(deliveredAt - loadedAt),
      stale: result.stale,
      refresh,
    });
  }
  return result.stale || identity?.stale ? { ...result.value, stale: true } : result.value;
}

/** Foreground session reads finish inline; no background refresh outlives caller authority. */
export async function loadSessionGitHubPreview(
  target: ControlUiGitHubPreviewTarget,
  identity: SessionGitHubReadIdentity,
  fetchImpl: typeof fetch = fetch,
): Promise<ControlUiGitHubPreview> {
  assertSessionGitHubTarget(target, identity);
  await identity.revalidate();
  const timeout = AbortSignal.timeout(GITHUB_PREVIEW_TIMEOUT_MS);
  const signal = identity.signal ? AbortSignal.any([timeout, identity.signal]) : timeout;
  const result = await fetchPreview(target, fetchImpl, signal, identity.token, identity, identity);
  await identity.revalidate();
  identity.assertSelected();
  return result;
}
