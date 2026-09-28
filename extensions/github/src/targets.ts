import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export type GitHubItemTarget = {
  kind: "issue" | "pull";
  owner: string;
  repo: string;
  number: number;
};
export type GitHubTarget =
  | GitHubItemTarget
  | { kind: "commit"; owner: string; repo: string; sha: string };

function isValidOwner(value: string): boolean {
  return /^(?=.{1,39}$)[a-z\d](?:[a-z\d-]*[a-z\d])?$/iu.test(value);
}

function isValidRepo(value: string): boolean {
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

export function parseGitHubItemTarget(value: unknown): GitHubItemTarget | null {
  const target = parseGitHubTarget(value);
  return target && target.kind !== "commit" ? target : null;
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

export function parseGitHubLinkParams(value: unknown): {
  target: GitHubTarget;
  url: string;
  agentId?: string;
  refresh: boolean;
  filesExpanded: boolean;
} | null {
  if (
    !isRecord(value) ||
    typeof value.url !== "string" ||
    value.url.length > 4096 ||
    (value.refresh !== undefined && typeof value.refresh !== "boolean") ||
    (value.agentId !== undefined && (typeof value.agentId !== "string" || !value.agentId.trim()))
  ) {
    return null;
  }
  try {
    const url = new URL(value.url);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
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
          filesExpanded: subpage === "files",
        }
      : null;
  } catch {
    return null;
  }
}

export function githubTargetUrl(target: GitHubTarget): string {
  const id = target.kind === "commit" ? target.sha : target.number;
  return `https://github.com/${target.owner}/${target.repo}/${target.kind === "issue" ? "issues" : target.kind}/${id}`;
}
