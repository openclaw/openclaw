import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isValidOwner, isValidRepo } from "./targets.js";

export type GitHubSearchParams = {
  repository: string;
  query: string;
  kind: "issue" | "pull";
  state: "all" | "open" | "closed";
  page: number;
};

export function validGitHubSearchRepository(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const [owner = "", repo = "", extra] = value.split("/", 3);
  return extra === undefined && isValidOwner(owner) && isValidRepo(repo);
}

export function quoteGitHubSearchKeywords(query: string): string {
  const text = query.trim();
  return text
    ? text
        .split(/\s+/u)
        .map((word) => `"${word}"`)
        .join(" ")
    : "";
}

export function parseGitHubSearchParams(value: unknown): GitHubSearchParams | null {
  if (
    !isRecord(value) ||
    !validGitHubSearchRepository(value.repository) ||
    Object.keys(value).some(
      (key) => !["repository", "query", "kind", "state", "page"].includes(key),
    )
  ) {
    return null;
  }
  const { query = "", kind, state = "all", page = 1 } = value;
  if (
    typeof query !== "string" ||
    query.length > 256 ||
    /["\\:()\p{Cc}]/u.test(query) ||
    quoteGitHubSearchKeywords(query).length > 256 ||
    (kind !== "issue" && kind !== "pull") ||
    (state !== "all" && state !== "open" && state !== "closed") ||
    typeof page !== "number" ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > 50
  ) {
    return null;
  }
  return { repository: value.repository, query: query.trim(), kind, state, page };
}
