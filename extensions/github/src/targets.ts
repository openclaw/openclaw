import type { ControlUiLinkReaderDetailParams } from "openclaw/plugin-sdk/control-ui-link-reader";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type GitHubItemTarget = {
  kind: "issue" | "pull";
  owner: string;
  repo: string;
  number: number;
};
export type GitHubTarget =
  | GitHubItemTarget
  | { kind: "commit"; owner: string; repo: string; sha: string };

export type GitHubJobTarget = {
  kind: "job";
  owner: string;
  repo: string;
  runId: number;
  jobId: number;
};
export type GitHubCodeScanningTarget = { kind: "code-scanning"; owner: string; repo: string } & (
  | { operation: "analyses"; ref: string; page: number }
  | { operation: "analysis"; analysisId: number }
  | { operation: "sarif"; sarifId: string }
);
export type GitHubReadTarget = GitHubTarget | GitHubJobTarget | GitHubCodeScanningTarget;

export function parseGitHubReadTarget(value: unknown): GitHubReadTarget | null {
  if (isRecord(value) && value.kind === "code-scanning") {
    const { owner, repo } = value;
    if (
      typeof owner !== "string" ||
      !isValidOwner(owner) ||
      typeof repo !== "string" ||
      !isValidRepo(repo)
    ) {
      return null;
    }
    const base = { kind: "code-scanning", owner, repo } as const;
    if (
      value.operation === "analyses" &&
      typeof value.ref === "string" &&
      value.ref.length > 0 &&
      value.ref.length <= 256 &&
      !value.ref.split("").some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      }) &&
      typeof value.page === "number" &&
      Number.isSafeInteger(value.page) &&
      value.page >= 1 &&
      value.page <= 50
    ) {
      return { ...base, operation: "analyses", ref: value.ref, page: value.page };
    }
    if (
      value.operation === "analysis" &&
      typeof value.analysisId === "number" &&
      Number.isSafeInteger(value.analysisId) &&
      value.analysisId > 0
    ) {
      return { ...base, operation: "analysis", analysisId: value.analysisId };
    }
    if (
      value.operation === "sarif" &&
      typeof value.sarifId === "string" &&
      /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu.test(value.sarifId)
    ) {
      return { ...base, operation: "sarif", sarifId: value.sarifId };
    }
    return null;
  }
  if (!isRecord(value) || value.kind !== "job") {
    return parseGitHubTarget(value);
  }
  const { owner, repo, runId, jobId } = value;
  return typeof owner === "string" &&
    isValidOwner(owner) &&
    typeof repo === "string" &&
    isValidRepo(repo) &&
    typeof runId === "number" &&
    Number.isSafeInteger(runId) &&
    runId > 0 &&
    typeof jobId === "number" &&
    Number.isSafeInteger(jobId) &&
    jobId > 0 &&
    value.sha === undefined &&
    value.number === undefined
    ? { kind: "job", owner, repo, runId, jobId }
    : null;
}

/** Job URLs are model-reader inputs; existing UI descriptors keep opening them externally. */
export function parseGitHubReadParams(value: unknown): {
  target: GitHubReadTarget;
  refresh: boolean;
} | null {
  const item = parseGitHubLinkParams(value);
  if (item) {
    return item;
  }
  if (
    !isRecord(value) ||
    typeof value.url !== "string" ||
    value.url.length > 4096 ||
    (value.refresh !== undefined && typeof value.refresh !== "boolean")
  ) {
    return null;
  }
  const url = URL.parse(value.url);
  if (!url || url.username || url.password) {
    return null;
  }
  if (url.origin === "https://api.github.com" && !url.hash) {
    const match =
      /^\/repos\/([^/]+)\/([^/]+)\/code-scanning\/(analyses|sarifs)(?:\/([^/]+))?$/u.exec(
        url.pathname,
      );
    if (!match) {
      return null;
    }
    const [, owner, repo, resource, id] = match;
    const list = resource === "analyses" && id === undefined;
    if (
      [...url.searchParams.keys()].some((key) => !list || !["ref", "page"].includes(key)) ||
      [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1)
    ) {
      return null;
    }
    const target = parseGitHubReadTarget({
      kind: "code-scanning",
      owner,
      repo,
      ...(list
        ? {
            operation: "analyses",
            ref: url.searchParams.get("ref"),
            page: Number(url.searchParams.get("page") ?? 1),
          }
        : resource === "analyses"
          ? { operation: "analysis", analysisId: /^\d+$/u.test(id ?? "") ? Number(id) : undefined }
          : { operation: "sarif", sarifId: id }),
    });
    return target ? { target, refresh: value.refresh === true } : null;
  }
  if (url.origin !== "https://github.com") {
    return null;
  }
  const match =
    /^\/([^/]+)\/([^/]+)\/actions\/runs\/([1-9]\d{0,15})\/job\/([1-9]\d{0,15})\/?$/u.exec(
      url.pathname,
    );
  const target =
    match &&
    parseGitHubReadTarget({
      kind: "job",
      owner: match[1],
      repo: match[2],
      runId: Number(match[3]),
      jobId: Number(match[4]),
    });
  return target ? { target, refresh: value.refresh === true } : null;
}

export function isValidOwner(value: string): boolean {
  return /^(?=.{1,39}$)[a-z\d](?:[a-z\d-]*[a-z\d])?$/iu.test(value);
}

export function isValidRepo(value: string): boolean {
  if (value.length < 1 || value.length > 100) {
    return false;
  }
  const lower = value.toLowerCase();
  // GitHub accepts dot/underscore/hyphen edge names, including consecutive
  // periods; only reject standalone path-confusion segments before visibility.
  if (!/^[a-z\d._-]+$/iu.test(value) || lower === "." || lower === "..") {
    return false;
  }
  return !lower.endsWith(".git") && !lower.endsWith(".atom");
}

export function parseGitHubTarget(value: unknown): GitHubTarget | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = value.kind;
  const owner = typeof value.owner === "string" ? value.owner.trim() : "";
  const repo = typeof value.repo === "string" ? value.repo.trim() : "";
  if (
    !isValidOwner(owner) ||
    !isValidRepo(repo) ||
    (value.agentId !== undefined && (typeof value.agentId !== "string" || !value.agentId.trim()))
  ) {
    return null;
  }
  if (kind === "commit") {
    const sha = value.sha;
    return value.number === undefined && typeof sha === "string" && /^[a-f\d]{7,40}$/iu.test(sha)
      ? { kind, owner, repo, sha: sha.toLowerCase() }
      : null;
  }
  const number = value.number;
  if (
    (kind !== "issue" && kind !== "pull") ||
    value.sha !== undefined ||
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    number > 9_999_999_999
  ) {
    return null;
  }
  return { kind, number, owner, repo };
}

// Descriptor matches only supported document pages; source/download/check links
// remain external. RPC validation below independently validates every segment.
export const GITHUB_ITEM_PATH_PATTERN =
  "^/[^/]+/[^/]+/(?:issues/[1-9][0-9]{0,9}|pull/[1-9][0-9]{0,9}(?:/files)?)/?$";
export const GITHUB_COMMIT_PATH_PATTERN = "^/[^/]+/[^/]+/commit/[a-fA-F0-9]{7,40}/?$";
const GITHUB_LINK_PATH = new RegExp(
  GITHUB_ITEM_PATH_PATTERN + "|" + GITHUB_COMMIT_PATH_PATTERN,
  "u",
);

export function parseGitHubLinkParams(
  value: unknown,
  host = "github.com",
): {
  target: GitHubTarget;
  url: string;
  agentId?: string;
  refresh: boolean;
  section?: ControlUiLinkReaderDetailParams["section"];
  filesExpanded: boolean;
} | null {
  if (
    !isRecord(value) ||
    typeof value.url !== "string" ||
    value.url.length > 4096 ||
    (value.refresh !== undefined && typeof value.refresh !== "boolean") ||
    (value.section !== undefined &&
      value.section !== "overview" &&
      value.section !== "checks" &&
      value.section !== "files" &&
      value.section !== "discussion") ||
    (value.agentId !== undefined && (typeof value.agentId !== "string" || !value.agentId.trim()))
  ) {
    return null;
  }
  try {
    const url = new URL(value.url);
    if (
      url.protocol !== "https:" ||
      url.hostname !== host ||
      url.username ||
      url.password ||
      url.port ||
      !GITHUB_LINK_PATH.test(url.pathname)
    ) {
      return null;
    }
    const [, owner, repo, surface, id, subpage] = url.pathname.split("/").map(decodeURIComponent);
    const target = parseGitHubTarget({
      owner,
      repo,
      kind: surface === "issues" ? "issue" : surface,
      ...(surface === "commit" ? { sha: id } : { number: Number(id) }),
    });
    return target
      ? {
          target,
          url: url.href,
          ...(typeof value.agentId === "string" ? { agentId: value.agentId.trim() } : {}),
          refresh: value.refresh === true,
          ...(value.section !== undefined ? { section: value.section } : {}),
          filesExpanded: subpage === "files",
        }
      : null;
  } catch {
    return null;
  }
}

export function githubTargetUrl(target: GitHubTarget, host = "github.com"): string {
  const id = target.kind === "commit" ? target.sha : target.number;
  return `https://${host}/${target.owner}/${target.repo}/${target.kind === "issue" ? "issues" : target.kind}/${id}`;
}
