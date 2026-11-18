import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { parseGitHubTarget, type GitHubTarget } from "./targets.js";

/** Host-prepared read identity; the plugin never discovers or selects managed credentials. */
export type ControlUiGitHubPreviewIdentity = {
  token: string | undefined;
  cacheScope: string;
  /** Host service/env credentials may retry a stale HTTP 401 anonymously. */
  optionalAuth?: true;
  stale?: true;
  signal?: AbortSignal;
  revalidate: () => Promise<void>;
  assertSelected: () => void;
};

// Shipped controlUi.githubPreview payload. The compatibility RPC retains these
// provider-specific fields; new readers consume generic passive documents.
/**
 * One co-author resolved from a `Co-authored-by` trailer. Only trailers using
 * GitHub's `<id>+<login>@users.noreply.github.com` form resolve, because the id
 * yields both the login and the avatar without a per-person API lookup.
 */
type ControlUiGitHubPreviewCoAuthor = {
  login: string;
  avatarDataUrl?: string;
};

export type ControlUiGitHubPreview = GitHubTarget & {
  stale?: boolean;
  additions?: number;
  avatarDataUrl?: string;
  /** Bounded to the faces the card renders; `coAuthorCount` carries the true total. */
  coAuthors?: ControlUiGitHubPreviewCoAuthor[];
  coAuthorCount?: number;
  changedFiles?: number;
  closedAt?: string;
  comments?: number;
  createdAt: string;
  deletions?: number;
  draft?: boolean;
  login: string;
  mergedAt?: string;
  state: string;
  stateReason?: string;
  title: string;
  updatedAt: string;
};

/** Validate the untyped dispatch payload before projecting it into a generic reader. */
export function isControlUiGitHubPreview(value: unknown): value is ControlUiGitHubPreview {
  if (!isRecord(value) || !parseGitHubTarget(value)) {
    return false;
  }
  return (
    ["createdAt", "login", "state", "title", "updatedAt"].every(
      (key) => typeof value[key] === "string",
    ) &&
    ["avatarDataUrl", "closedAt", "mergedAt", "stateReason"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    ) &&
    ["additions", "changedFiles", "comments", "deletions", "coAuthorCount"].every(
      (key) =>
        value[key] === undefined || (typeof value[key] === "number" && Number.isFinite(value[key])),
    ) &&
    (value.stale === undefined || typeof value.stale === "boolean") &&
    (value.draft === undefined || typeof value.draft === "boolean") &&
    (value.coAuthors === undefined ||
      (Array.isArray(value.coAuthors) &&
        value.coAuthors.every(
          (author: unknown) =>
            isRecord(author) &&
            typeof author.login === "string" &&
            (author.avatarDataUrl === undefined || typeof author.avatarDataUrl === "string"),
        )))
  );
}
