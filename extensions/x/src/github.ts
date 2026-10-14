import { asOptionalRecord as record } from "openclaw/plugin-sdk/string-coerce-runtime";
import { fetchXService } from "./fetch.js";

export type XGitHubPermission = "push" | "maintain" | "admin";
export type XGitHubCollaborator = {
  githubLogin: string;
  permission: XGitHubPermission;
  xHandles: string[];
};

export class XGitHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XGitHubError";
  }
}

type Cached<T> = { etag?: string; value: T };
type ProfileCache = {
  githubId: number;
  profile?: Cached<string[]>;
  social?: Cached<string[]>;
};

const PERMISSION_RANK = { push: 1, maintain: 2, admin: 3 };
// Enterprise-managed accounts append an underscore and enterprise shortcode.
const LOGIN_PATTERN = /^[a-z\d][a-z\d_-]*$/i;

function xHandle(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  let handle = value.trim();
  if (/^https?:\/\//i.test(handle)) {
    try {
      const url = new URL(handle);
      if (
        !["x.com", "twitter.com", "www.x.com", "www.twitter.com"].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.port ||
        url.search ||
        url.hash
      ) {
        return undefined;
      }
      handle = url.pathname.replace(/^\//, "").replace(/\/$/, "");
    } catch {
      return undefined;
    }
  }
  handle = handle.replace(/^@/, "");
  return /^[a-z\d_]{1,15}$/i.test(handle) ? handle.toLowerCase() : undefined;
}

function invalidResponse(): never {
  throw new XGitHubError(
    "GitHub returned an invalid response; the last verified set is unchanged.",
  );
}

function retryDeadline(response: Response): number | undefined {
  const now = Date.now();
  const retry = response.headers.get("retry-after");
  const seconds = retry === null ? Number.NaN : Number(retry);
  const after =
    retry === null
      ? Number.NaN
      : Number.isFinite(seconds)
        ? now + seconds * 1_000
        : Date.parse(retry);
  const reset = Number(response.headers.get("x-ratelimit-reset")) * 1_000;
  const deadlines = [after, reset].filter((value) => Number.isFinite(value) && value > now);
  return deadlines.length ? Math.max(...deadlines) : undefined;
}

export function createXGitHubReader(options: {
  token: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  const profiles = new Map<string, ProfileCache>();
  let retryAt = 0;

  function rateLimited(): never {
    throw new XGitHubError(
      `GitHub rate limit reached; retry after ${new Date(retryAt).toISOString()}.`,
    );
  }

  async function request<T>(
    path: string,
    parse: (body: unknown) => T,
    signal?: AbortSignal,
    cached?: Cached<T>,
  ): Promise<Cached<T>> {
    if (Date.now() < retryAt) {
      rateLimited();
    }
    if (!options.token.trim()) {
      throw new XGitHubError(
        "Configure verifiedFromGitHub.token with a GitHub credential that can list repository collaborators.",
      );
    }
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000);
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${options.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (cached?.etag) {
      headers["If-None-Match"] = cached.etag;
    }
    const init: RequestInit = { method: "GET", headers, signal: requestSignal, redirect: "error" };
    let response: Response;
    try {
      requestSignal.throwIfAborted();
      response = await fetchXService("api.github.com", path, init, options.fetch);
    } catch {
      throw new XGitHubError(
        "GitHub request failed or was cancelled; the last verified set is unchanged.",
      );
    }
    const exhausted = response.headers.get("x-ratelimit-remaining") === "0";
    if (exhausted) {
      retryAt = retryDeadline(response) ?? Date.now() + 60_000;
    }
    if (response.status === 304) {
      await response.body?.cancel();
      return cached ?? invalidResponse();
    }
    let body: unknown;
    try {
      const { readResponseWithLimit } = await import("openclaw/plugin-sdk/response-limit-runtime");
      const bytes = await readResponseWithLimit(response, 2_000_000, {
        signal: requestSignal,
        timeoutMs: 30_000,
      });
      body = JSON.parse(bytes.toString());
    } catch {
      if (response.ok) {
        invalidResponse();
      }
    }
    if (!response.ok) {
      const message = record(body)?.message;
      if (
        response.status === 429 ||
        (response.status === 403 &&
          (exhausted ||
            response.headers.has("retry-after") ||
            (typeof message === "string" && /secondary rate limit|abuse detection/i.test(message))))
      ) {
        retryAt = retryDeadline(response) ?? Date.now() + 60_000;
        rateLimited();
      }
      if ([401, 403, 404].includes(response.status) && path.startsWith("/repos/")) {
        throw new XGitHubError(
          `GitHub cannot list repository collaborators (HTTP ${response.status}); check the repository and verifiedFromGitHub.token access and permissions.`,
        );
      }
      throw new XGitHubError(
        `GitHub request failed (HTTP ${response.status}); check verifiedFromGitHub.token and retry.`,
      );
    }
    return { etag: response.headers.get("etag") ?? undefined, value: parse(body) };
  }

  return {
    async readCollaborators(
      repo: string,
      minPermission: XGitHubPermission,
      signal?: AbortSignal,
    ): Promise<XGitHubCollaborator[]> {
      const [owner, repository, extra] = repo.split("/");
      if (
        !owner ||
        !LOGIN_PATTERN.test(owner) ||
        !repository ||
        !/^[a-z\d_.-]{1,100}$/i.test(repository) ||
        [".", ".."].includes(repository) ||
        extra !== undefined
      ) {
        throw new XGitHubError("verifiedFromGitHub.repo must be owner/name.");
      }
      const collaborators = new Map<
        string,
        Omit<XGitHubCollaborator, "xHandles"> & { githubId: number }
      >();
      for (let page = 1; ; page++) {
        const { value: rows } = await request(
          `/repos/${repo}/collaborators?affiliation=all&per_page=100&page=${page}`,
          (body) => {
            if (!Array.isArray(body) || body.length > 100) {
              invalidResponse();
            }
            return body.map((value) => {
              const row = record(value);
              const permissions = record(row?.permissions);
              if (
                typeof row?.login !== "string" ||
                !LOGIN_PATTERN.test(row.login) ||
                typeof row.id !== "number" ||
                !Number.isSafeInteger(row.id) ||
                row.id <= 0 ||
                !permissions ||
                typeof permissions.push !== "boolean" ||
                [permissions.maintain, permissions.admin].some(
                  (flag) => flag !== undefined && typeof flag !== "boolean",
                )
              ) {
                invalidResponse();
              }
              const permission: XGitHubPermission | undefined = permissions.admin
                ? "admin"
                : permissions.maintain
                  ? "maintain"
                  : permissions.push
                    ? "push"
                    : undefined;
              return { githubLogin: row.login, githubId: row.id, permission };
            });
          },
          signal,
        );
        for (const row of rows) {
          if (row.permission && PERMISSION_RANK[row.permission] >= PERMISSION_RANK[minPermission]) {
            collaborators.set(row.githubLogin.toLowerCase(), {
              githubLogin: row.githubLogin,
              githubId: row.githubId,
              permission: row.permission,
            });
          }
        }
        if (rows.length < 100) {
          break;
        }
      }
      for (const login of profiles.keys()) {
        if (!collaborators.has(login)) {
          profiles.delete(login);
        }
      }
      const result: XGitHubCollaborator[] = [];
      for (const [login, collaborator] of collaborators) {
        const previous = profiles.get(login);
        const cache =
          previous?.githubId === collaborator.githubId
            ? previous
            : { githubId: collaborator.githubId };
        profiles.set(login, cache);
        cache.profile = await request(
          `/users/${encodeURIComponent(login)}`,
          (body) => {
            const row = record(body);
            if (
              typeof row?.login !== "string" ||
              row.login.toLowerCase() !== login ||
              row.id !== collaborator.githubId ||
              (row.twitter_username !== null &&
                row.twitter_username !== undefined &&
                typeof row.twitter_username !== "string")
            ) {
              invalidResponse();
            }
            const handle = xHandle(row.twitter_username);
            return handle ? [handle] : [];
          },
          signal,
          cache.profile,
        );
        cache.social = await request(
          `/users/${encodeURIComponent(login)}/social_accounts`,
          (body) => {
            if (!Array.isArray(body)) {
              invalidResponse();
            }
            return body.flatMap((value) => {
              const row = record(value);
              if (!row || typeof row.provider !== "string" || typeof row.url !== "string") {
                invalidResponse();
              }
              const handle =
                row.provider.toLowerCase() === "twitter" ||
                /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(row.url)
                  ? xHandle(row.url)
                  : undefined;
              return handle ? [handle] : [];
            });
          },
          signal,
          cache.social,
        );
        result.push({
          githubLogin: collaborator.githubLogin,
          permission: collaborator.permission,
          xHandles: [...new Set([...cache.profile.value, ...cache.social.value])],
        });
      }
      return result;
    },
  };
}
