import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import type { ControlUiLinkReaderDocument } from "openclaw/plugin-sdk/control-ui-link-reader";
import {
  ControlUiGitHubError,
  fetchGitHubApi,
  GITHUB_API_ORIGIN,
  isRecord,
  optionalNumber,
  readGitHubJsonResponse,
  readOptionalGitHubString,
  requiredString,
} from "./github-api.js";
import { assertPublicGitHubRepository, parseControlUiGitHubPreviewResponse } from "./preview.js";
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
const detailCache = new Map<string, { expiresAt: number; promise: Promise<GitHubDocument> }>();

type JsonPage = { value: unknown; hasNextPage: boolean };

async function fetchDetailPage(url: string, fetchImpl: typeof fetch): Promise<JsonPage> {
  // Detail bodies and patches never borrow the Gateway's ambient token. A
  // visibility check followed by an authenticated fetch can race a transfer or
  // visibility change; anonymous subresources cannot disclose private content.
  const response = await fetchGitHubApi(url, fetchImpl);
  return {
    hasNextPage: /;\s*rel="next"/u.test(response.headers.get("link") ?? ""),
    value: await readGitHubJsonResponse(response, DETAIL_JSON_MAX_BYTES),
  };
}

function markdownBody(value: unknown, maxChars: number): { body: string; bodyTruncated: boolean } {
  const body = typeof value === "string" ? value : "";
  return { body: body.slice(0, maxChars), bodyTruncated: body.length > maxChars };
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
  fetchImpl: typeof fetch,
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
    const page = await fetchDetailPage(url + "?per_page=" + COMMENT_LIMIT + sort, fetchImpl);
    const comments = parseComments(page.value, kind);
    return {
      comments,
      commentsTotal: total,
      commentsTruncated:
        page.hasNextPage ||
        total > comments.length ||
        (Array.isArray(page.value) && page.value.length > COMMENT_LIMIT),
    };
  } catch {
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
    const patch = rawPatch?.slice(0, Math.min(PATCH_MAX_CHARS, remainingPatchChars));
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

async function fetchDetail(target: GitHubTarget, fetchImpl: typeof fetch): Promise<GitHubDocument> {
  const repoPath = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  const repositoryUrl = GITHUB_API_ORIGIN + repoPath;
  await assertPublicGitHubRepository(repositoryUrl, fetchImpl);
  const collection =
    target.kind === "commit" ? "commits" : target.kind === "pull" ? "pulls" : "issues";
  const id = target.kind === "commit" ? target.sha : target.number;
  const itemUrl = `${repositoryUrl}/${collection}/${id}`;
  const itemPage = await fetchDetailPage(
    target.kind === "commit" ? `${itemUrl}?per_page=${FILE_LIMIT}` : itemUrl,
    fetchImpl,
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
      fetchImpl,
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
    fetchImpl,
  );
  const review =
    target.kind === "pull"
      ? await fetchComments(
          itemUrl + "/comments",
          "review",
          requiredCount(value, "review_comments"),
          fetchImpl,
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
      const page = await fetchDetailPage(`${itemUrl}/files?per_page=${FILE_LIMIT}`, fetchImpl);
      files = parseFiles(page.value);
      filesTruncated = page.hasNextPage || filesTotal > files.length;
    } catch {
      filesTruncated = true;
    }
  }
  return {
    ...githubPreviewView(preview),
    metadata: githubChangeMetadata(
      preview.additions,
      preview.deletions,
      preview.changedFiles,
      preview.comments,
    ),
    url,
    ...content,
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
      comments.some((comment) => comment.bodyTruncated || comment.context?.diffTruncated) ||
      files.some((file) => file.patchTruncated),
  };
}

export function loadGitHubDetail(
  target: GitHubTarget,
  fetchImpl: typeof fetch = fetch,
  refresh = false,
): Promise<GitHubDocument> {
  const parsed = parseGitHubTarget(target);
  if (!parsed) {
    return Promise.reject(new ControlUiGitHubError(400, "Invalid GitHub detail target"));
  }
  const id = parsed.kind === "commit" ? parsed.sha : parsed.number;
  const key = `${parsed.kind}:${parsed.owner.toLowerCase()}/${parsed.repo.toLowerCase()}#${id}`;
  const cached = detailCache.get(key);
  if (!refresh && cached && cached.expiresAt > Date.now()) {
    detailCache.delete(key);
    detailCache.set(key, cached);
    return cached.promise;
  }
  const entry = {
    expiresAt: Date.now() + SUCCESS_CACHE_MS,
    promise: fetchDetail(parsed, fetchImpl)
      .then((detail) => {
        if (detail.partial) {
          entry.expiresAt = Date.now() + PARTIAL_CACHE_MS;
        }
        return detail;
      })
      .catch((error: unknown) => {
        // Repeated opens share in-flight work and short failure caching rather
        // than spending the anonymous API quota again on every click.
        entry.expiresAt = Date.now() + PARTIAL_CACHE_MS;
        throw error;
      }),
  };
  detailCache.delete(key);
  detailCache.set(key, entry);
  pruneMapToMaxSize(detailCache, CACHE_LIMIT);
  return entry.promise;
}
