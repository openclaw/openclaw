import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import type { ControlUiLinkReaderDocument } from "openclaw/plugin-sdk/control-ui-link-reader";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/string-coerce-runtime";
import { fetchPullChecks } from "./detail-checks.js";
import {
  ControlUiGitHubError,
  fetchGitHubApi,
  GITHUB_API_ORIGIN,
  githubApiCredentialCacheScope,
  isRecord,
  optionalNumber,
  readGitHubJsonResponse,
  readOptionalGitHubString,
  requiredString,
  withOptionalGitHubAuth,
} from "./github-api.js";
import {
  assertPublicGitHubRepository,
  isPublicGitHubRepository,
  parseControlUiGitHubPreviewResponse,
  type ControlUiGitHubPreviewIdentity,
} from "./preview.js";
import { githubTargetUrl, parseGitHubTarget, type GitHubTarget } from "./targets.js";
import { githubPreviewView, githubChangeMetadata } from "./view-model.js";
type GitHubComment = NonNullable<ControlUiLinkReaderDocument["comments"]>[number];
type GitHubFile = NonNullable<ControlUiLinkReaderDocument["files"]>[number];
type GitHubDocument = ControlUiLinkReaderDocument & {
  comments: GitHubComment[];
  files: GitHubFile[];
};
type CommentKind = "discussion" | "review" | "commit";

const DETAIL_JSON_MAX_BYTES = 1024 * 1024;
const BODY_MAX_CHARS = 32 * 1024;
const COMMENT_LIMIT = 20;
const COMMENT_MAX_CHARS = 4 * 1024;
const FILE_LIMIT = 30;
const PATCH_MAX_CHARS = 16 * 1024;
const PATCH_TOTAL_MAX_CHARS = 96 * 1024;
const SUCCESS_CACHE_MS = 5 * 60_000;
const PARTIAL_CACHE_MS = 30_000;
const CACHE_LIMIT = 32;
type CachedDocument = {
  document: GitHubDocument;
  repositoryId?: number;
  repositoryUrls: string[];
};
const detailCache = new Map<
  string,
  { expiresAt: number; settled: boolean; promise: Promise<CachedDocument> }
>();

type JsonPage = { value: unknown; hasNextPage: boolean };
type ReadDetailPage = (url: string) => Promise<JsonPage>;

class GitHubDetailAccessError extends ControlUiGitHubError {
  constructor() {
    super(404, "GitHub repository is not public or has changed");
  }
}

function redirectedRepositoryUrl(url: URL, suffix: string): string {
  const match = /^(\/repos\/[^/]+\/[^/]+|\/repositories\/\d+)(\/.*)?$/u.exec(url.pathname);
  if (!match || (match[2] ?? "") !== suffix) {
    throw new GitHubDetailAccessError();
  }
  return GITHUB_API_ORIGIN + match[1];
}

async function readPublicRepository(
  url: string,
  fetchImpl: typeof fetch,
  identity: ControlUiGitHubPreviewIdentity,
  expectedId?: number,
): Promise<number> {
  const repository = await readGitHubJsonResponse(
    await fetchGitHubApi(
      url,
      fetchImpl,
      identity.token,
      async (redirect) => {
        redirectedRepositoryUrl(redirect, "");
      },
      identity,
    ),
  );
  const id = isRecord(repository) ? optionalNumber(repository, "id") : undefined;
  if (
    !isPublicGitHubRepository(repository) ||
    id === undefined ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    (expectedId !== undefined && id !== expectedId)
  ) {
    throw new GitHubDetailAccessError();
  }
  return id;
}

function markdownBody(value: unknown, maxChars: number): { body: string; bodyTruncated: boolean } {
  const body = typeof value === "string" ? value : "";
  return { body: truncateUtf16Safe(body, maxChars), bodyTruncated: body.length > maxChars };
}

function requiredCount(value: Record<string, unknown>, key: string): number {
  const count = optionalNumber(value, key);
  if (count === undefined || !Number.isSafeInteger(count) || count < 0) {
    throw new ControlUiGitHubError(502, `GitHub response omitted ${key}`);
  }
  return count;
}

function commentPosition(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function commentUrl(comment: Record<string, unknown>): string {
  const url = new URL(requiredString(comment, "html_url"));
  if (url.origin !== "https://github.com" || url.username || url.password) {
    throw new ControlUiGitHubError(502, "GitHub comment returned an unsafe permalink");
  }
  return url.href;
}

function parseComments(value: unknown, kind: CommentKind): GitHubComment[] {
  if (!Array.isArray(value)) {
    throw new ControlUiGitHubError(502, "GitHub comments were not an array");
  }
  return value.slice(0, COMMENT_LIMIT).map((comment: unknown) => {
    if (!isRecord(comment)) {
      throw new ControlUiGitHubError(502, "GitHub comment was not an object");
    }
    const user = isRecord(comment.user) ? comment.user : {};
    const { body, bodyTruncated } = markdownBody(comment.body, COMMENT_MAX_CHARS);
    const diffHunk =
      kind === "review" ? markdownBody(comment.diff_hunk, COMMENT_MAX_CHARS) : undefined;
    const id = requiredCount(comment, "id");
    const url = commentUrl(comment);
    const path = kind !== "discussion" ? readOptionalGitHubString(comment, "path") : undefined;
    const line = commentPosition(comment.line) ?? commentPosition(comment.original_line);
    const start =
      commentPosition(comment.start_line) ?? commentPosition(comment.original_start_line);
    const lineLabel =
      line === undefined
        ? undefined
        : (start !== undefined && start !== line ? start + "–" : "") + line;
    const replyId = kind === "review" ? commentPosition(comment.in_reply_to_id) : undefined;
    const locationLabels = [
      comment.side === "LEFT"
        ? "Before change"
        : comment.side === "RIGHT"
          ? "After change"
          : undefined,
      comment.line == null && commentPosition(comment.original_line) ? "Outdated" : undefined,
    ].filter(Boolean);
    const parsed: GitHubComment = {
      id:
        new URL(url).hash.slice(1) ||
        (kind === "review"
          ? "discussion_r"
          : kind === "commit"
            ? "commitcomment-"
            : "issuecomment-") + id,
      url,
      author: readOptionalGitHubString(user, "login") ?? "ghost",
      createdAt: requiredString(comment, "created_at"),
      body,
      bodyTruncated,
      label: kind === "review" ? "Review comment" : undefined,
      context:
        kind !== "discussion"
          ? {
              path,
              lineLabel,
              label: locationLabels.join(" · ") || undefined,
              diff: diffHunk?.body,
              diffTruncated:
                kind === "review"
                  ? typeof comment.diff_hunk !== "string" || diffHunk?.bodyTruncated
                  : undefined,
              replyUrl:
                replyId === undefined ? undefined : new URL("#discussion_r" + replyId, url).href,
              replyLabel: replyId === undefined ? undefined : "In reply to #" + replyId,
            }
          : undefined,
    };
    return parsed;
  });
}

async function fetchComments(
  url: string,
  kind: CommentKind,
  total: number,
  readPage: ReadDetailPage,
): Promise<{
  comments: GitHubComment[];
  commentsTotal: number;
  commentsTruncated: boolean;
}> {
  if (total === 0) {
    return { comments: [], commentsTotal: 0, commentsTruncated: false };
  }
  try {
    // Each collection has an independent quota so discussion cannot crowd out
    // published review threads. Never follow arbitrary Link URLs from GitHub.
    const sort = kind === "review" ? "&sort=created&direction=asc" : "";
    const page = await readPage(url + "?per_page=" + COMMENT_LIMIT + sort);
    const comments = parseComments(page.value, kind);
    return {
      comments,
      commentsTotal: total,
      commentsTruncated:
        page.hasNextPage ||
        total > comments.length ||
        (Array.isArray(page.value) && page.value.length > COMMENT_LIMIT),
    };
  } catch (error) {
    if (error instanceof GitHubDetailAccessError) {
      throw error;
    }
    return { comments: [], commentsTotal: total, commentsTruncated: true };
  }
}

function parseFiles(value: unknown): GitHubFile[] {
  if (!Array.isArray(value)) {
    throw new ControlUiGitHubError(502, "GitHub files were not an array");
  }
  let remainingPatchChars = PATCH_TOTAL_MAX_CHARS;
  return value.slice(0, FILE_LIMIT).map((file: unknown) => {
    if (!isRecord(file)) {
      throw new ControlUiGitHubError(502, "GitHub file was not an object");
    }
    const rawPatch = typeof file.patch === "string" ? file.patch : undefined;
    const patch =
      rawPatch === undefined
        ? undefined
        : truncateUtf16Safe(rawPatch, Math.min(PATCH_MAX_CHARS, remainingPatchChars));
    remainingPatchChars -= patch?.length ?? 0;
    return {
      path: requiredString(file, "filename"),
      previousPath: readOptionalGitHubString(file, "previous_filename"),
      status: requiredString(file, "status"),
      additions: requiredCount(file, "additions"),
      deletions: requiredCount(file, "deletions"),
      patch,
      // GitHub omits binary/oversized patches; do not imply a complete diff.
      patchTruncated: rawPatch === undefined || patch?.length !== rawPatch.length,
    };
  });
}

async function fetchDetail(
  target: GitHubTarget,
  readPage: ReadDetailPage,
): Promise<GitHubDocument> {
  const repoPath = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  const repositoryUrl = GITHUB_API_ORIGIN + repoPath;
  const collection =
    target.kind === "commit" ? "commits" : target.kind === "pull" ? "pulls" : "issues";
  const id = target.kind === "commit" ? target.sha : target.number;
  const itemUrl = `${repositoryUrl}/${collection}/${id}`;
  const itemPage = await readPage(
    target.kind === "commit" ? `${itemUrl}?per_page=${FILE_LIMIT}` : itemUrl,
  );
  if (!isRecord(itemPage.value)) {
    throw new ControlUiGitHubError(502, "GitHub response was not an object");
  }
  const value = itemPage.value;
  const url = githubTargetUrl(target);
  if (target.kind === "commit") {
    const commit = isRecord(value.commit) ? value.commit : {};
    const author = isRecord(value.author) ? value.author : {};
    const commitAuthor = isRecord(commit.author) ? commit.author : {};
    const stats = isRecord(value.stats) ? value.stats : {};
    const content = markdownBody(commit.message, BODY_MAX_CHARS);
    const discussion = await fetchComments(
      itemUrl + "/comments",
      "commit",
      requiredCount(commit, "comment_count"),
      readPage,
    );
    const files = value.files === undefined ? [] : parseFiles(value.files);
    const filesTruncated =
      value.files === undefined ||
      itemPage.hasNextPage ||
      (Array.isArray(value.files) && value.files.length > FILE_LIMIT);
    return {
      url,
      subtitle:
        target.owner + "/" + target.repo + " · " + requiredString(value, "sha").slice(0, 12),
      badge: { label: "Commit", tone: "neutral" },
      title: content.body.split("\n", 1)[0] ?? "",
      author:
        readOptionalGitHubString(author, "login") ??
        readOptionalGitHubString(commitAuthor, "name") ??
        "ghost",
      createdAt: readOptionalGitHubString(commitAuthor, "date"),
      metadata: githubChangeMetadata(
        optionalNumber(stats, "additions"),
        optionalNumber(stats, "deletions"),
      ),
      ...content,
      ...discussion,
      files,
      filesTruncated,
      partial:
        content.bodyTruncated ||
        discussion.commentsTruncated ||
        filesTruncated ||
        discussion.comments.some((comment) => comment.bodyTruncated) ||
        files.some((file) => file.patchTruncated),
    };
  }

  const { preview } = parseControlUiGitHubPreviewResponse(target, value);
  const content = markdownBody(value.body, BODY_MAX_CHARS);
  const discussion = await fetchComments(
    repositoryUrl + "/issues/" + target.number + "/comments",
    "discussion",
    requiredCount(value, "comments"),
    readPage,
  );
  const review =
    target.kind === "pull"
      ? await fetchComments(
          itemUrl + "/comments",
          "review",
          requiredCount(value, "review_comments"),
          readPage,
        )
      : undefined;
  const comments = discussion.comments
    .concat(review?.comments ?? [])
    .toSorted(
      (left, right) =>
        (left.createdAt ?? "").localeCompare(right.createdAt ?? "") ||
        left.id.localeCompare(right.id, "en", { numeric: true }),
    );
  const commentsTotal = discussion.commentsTotal + (review?.commentsTotal ?? 0);
  const commentsTruncated = discussion.commentsTruncated || review?.commentsTruncated === true;
  let files: GitHubFile[] = [];
  let filesTruncated = false;
  const filesTotal = target.kind === "pull" ? requiredCount(value, "changed_files") : 0;
  if (filesTotal > 0) {
    try {
      const page = await readPage(`${itemUrl}/files?per_page=${FILE_LIMIT}`);
      files = parseFiles(page.value);
      filesTruncated = page.hasNextPage || filesTotal > files.length;
    } catch (error) {
      if (error instanceof GitHubDetailAccessError) {
        throw error;
      }
      filesTruncated = true;
    }
  }
  const head = isRecord(value.head) ? value.head : {};
  const base = isRecord(value.base) ? value.base : {};
  const checks =
    target.kind === "pull"
      ? await fetchPullChecks(repositoryUrl, head.sha, url + "/checks", readPage)
      : undefined;
  const view = githubPreviewView(preview);
  const metadata = githubChangeMetadata(
    preview.additions,
    preview.deletions,
    preview.changedFiles,
    preview.comments,
  );
  const headRef = readOptionalGitHubString(head, "ref")?.slice(0, 256);
  const baseRef = readOptionalGitHubString(base, "ref")?.slice(0, 256);
  return {
    ...view,
    metadata:
      target.kind === "pull" && headRef && baseRef
        ? [...metadata, { label: "Branch", value: headRef + " → " + baseRef }]
        : metadata,
    url,
    ...content,
    ...(checks ? { checks } : {}),
    comments,
    commentsTotal,
    commentsTruncated,
    files,
    filesTotal,
    filesTruncated,
    partial:
      content.bodyTruncated ||
      commentsTruncated ||
      filesTruncated ||
      checks?.truncated === true ||
      checks?.state === "unavailable" ||
      comments.some((comment) => comment.bodyTruncated || comment.context?.diffTruncated) ||
      files.some((file) => file.patchTruncated),
  };
}

async function loadGitHubDetailWithIdentity(
  target: GitHubTarget,
  identity?: ControlUiGitHubPreviewIdentity,
  fetchImpl: typeof fetch = fetch,
  refresh = false,
): Promise<GitHubDocument> {
  const parsed = parseGitHubTarget(target);
  if (!parsed) {
    throw new ControlUiGitHubError(400, "Invalid GitHub detail target");
  }
  await identity?.revalidate();
  identity?.assertSelected();
  const id = parsed.kind === "commit" ? parsed.sha : parsed.number;
  const key = `${parsed.kind}:${parsed.owner.toLowerCase()}/${parsed.repo.toLowerCase()}#${id}\0${identity?.cacheScope ?? "anonymous"}\0${githubApiCredentialCacheScope(identity?.token)}`;
  const assertDelivery = async (result: CachedDocument) => {
    if (identity?.token) {
      for (const url of result.repositoryUrls) {
        await readPublicRepository(url, fetchImpl, identity, result.repositoryId);
      }
    }
    await identity?.revalidate();
    identity?.assertSelected();
  };
  const cached = detailCache.get(key);
  if (!refresh && cached && cached.expiresAt > Date.now() && (!identity || cached.settled)) {
    detailCache.delete(key);
    detailCache.set(key, cached);
    const result = await cached.promise;
    await assertDelivery(result);
    return result.document;
  }
  detailCache.delete(key);
  const load = async (): Promise<CachedDocument> => {
    const repositoryUrl = `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
    const repositoryUrls = new Set([repositoryUrl]);
    const repositoryId = identity?.token
      ? await readPublicRepository(repositoryUrl, fetchImpl, identity)
      : undefined;
    if (!identity?.token) {
      await assertPublicGitHubRepository(repositoryUrl, fetchImpl, undefined, identity);
    }
    const readPage: ReadDetailPage = async (url) => {
      const suffix = new URL(url).pathname.slice(new URL(repositoryUrl).pathname.length);
      const response = await fetchGitHubApi(
        url,
        fetchImpl,
        identity?.token,
        identity?.token
          ? async (redirect) => {
              const redirected = redirectedRepositoryUrl(redirect, suffix);
              await readPublicRepository(redirected, fetchImpl, identity, repositoryId);
              repositoryUrls.add(redirected);
            }
          : undefined,
        identity,
      );
      return {
        hasNextPage: /;\s*rel="next"/u.test(response.headers.get("link") ?? ""),
        value: await readGitHubJsonResponse(response, DETAIL_JSON_MAX_BYTES),
      };
    };
    const document = await fetchDetail(parsed, readPage);
    const result = { document, repositoryId, repositoryUrls: [...repositoryUrls] };
    // Public-only delivery is checked after all awaited content reads, including
    // optional comments/files; a failed authority check cannot become partial data.
    await assertDelivery(result);
    return result;
  };
  const entry = {
    expiresAt: Date.now() + SUCCESS_CACHE_MS,
    settled: false,
    promise: load()
      .then((result) => {
        entry.settled = true;
        // PR checks and heads change independently of the body.
        if (parsed.kind === "pull" || result.document.partial) {
          entry.expiresAt = Date.now() + PARTIAL_CACHE_MS;
        }
        return result;
      })
      .catch((error: unknown) => {
        // Caller-lifetime failures must not poison another reader's cache.
        if (error instanceof ControlUiGitHubError && error.statusCode !== 409) {
          entry.settled = true;
          entry.expiresAt = Date.now() + PARTIAL_CACHE_MS;
        } else if (detailCache.get(key) === entry) {
          detailCache.delete(key);
        }
        throw error;
      }),
  };
  // Track the newest request immediately so older completions cannot replace a
  // refresh. Prepared identities reuse only settled, caller-independent results.
  detailCache.set(key, entry);
  pruneMapToMaxSize(detailCache, CACHE_LIMIT);
  const result = await entry.promise;
  identity?.assertSelected();
  return result.document;
}

export function loadGitHubDetail(
  target: GitHubTarget,
  identity?: ControlUiGitHubPreviewIdentity,
  fetchImpl: typeof fetch = fetch,
  refresh = false,
): Promise<GitHubDocument> {
  return identity?.optionalAuth
    ? withOptionalGitHubAuth(identity.token, (token) =>
        loadGitHubDetailWithIdentity(target, { ...identity, token }, fetchImpl, refresh),
      )
    : loadGitHubDetailWithIdentity(target, identity, fetchImpl, refresh);
}
