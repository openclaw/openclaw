import { parseRetryAfterHeaderSeconds } from "openclaw/plugin-sdk/retry-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { z } from "zod";
import type { GithubSourceConfig, SourceStatus } from "../../types.js";
import {
  ApiResponseReadError,
  createResponseParser,
  parseApiBase,
  readApiResponse,
} from "../http.js";

export class GithubSourceError extends Error {}

export class GithubHttpError extends GithubSourceError {
  constructor(readonly status: number) {
    super(`HTTP ${status}; check token permissions and repository access`);
  }
}

export const parse = createResponseParser(
  () => new GithubSourceError("Invalid API response; check API compatibility"),
);

export function pathWithQuery(path: string, query: Record<string, string>): string {
  return `${path}?${new URLSearchParams({ per_page: "100", ...query })}`;
}

export class GithubClient {
  private readonly base: URL;

  constructor(
    private readonly cfg: GithubSourceConfig,
    readonly status: SourceStatus,
  ) {
    try {
      this.base = parseApiBase(cfg.apiBaseUrl, "GitHub");
    } catch {
      throw new GithubSourceError(
        "GitHub API base URL must be HTTPS without credentials, query, or fragment",
      );
    }
  }

  warn(scope: string, error: unknown): void {
    const detail =
      error instanceof GithubSourceError
        ? error.message
        : "Request failed; check API access and connectivity";
    const message = `${scope}: ${detail}`;
    this.status.warnings.push(
      this.cfg.token ? message.replaceAll(this.cfg.token, "[redacted]") : message,
    );
    this.status.stale = true;
    this.status.ok = false;
  }

  async attempt(scope: string, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.warn(scope, error);
    }
  }

  private url(path: string): URL {
    const url = new URL(path.replace(/^\/(?!\/)/, ""), this.base);
    if (
      url.origin !== this.base.origin ||
      !url.pathname.startsWith(this.base.pathname) ||
      url.username ||
      url.password
    ) {
      throw new GithubSourceError("Refused API pagination outside the configured base URL");
    }
    return url;
  }

  async get(path: string): Promise<{ data: unknown; next?: string }> {
    const url = this.url(path);
    for (let failures = 0; ;) {
      let response: Awaited<ReturnType<typeof readApiResponse>>;
      let data: unknown;
      try {
        response = await readApiResponse(
          url,
          {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            Authorization: `Bearer ${this.cfg.token}`,
          },
          this.status,
        );
        data = response.data;
        if (response.status >= 200 && response.status < 300 && data === undefined) {
          throw new GithubSourceError("Invalid JSON API response");
        }
      } catch (error) {
        if (error instanceof GithubSourceError) {
          throw error;
        }
        throw new GithubSourceError(
          error instanceof ApiResponseReadError
            ? error.kind === "timeout"
              ? "API request timed out"
              : "Could not release API response"
            : "Request failed; check API access and connectivity",
        );
      }
      const remaining = response.headers.get("x-ratelimit-remaining");
      if (remaining !== null && Number.isFinite(Number(remaining))) {
        this.status.stats.rateLimitRemaining = Number(remaining);
      }
      const retryAfter = parseRetryAfterHeaderSeconds(response.headers.get("retry-after"));
      const resetHeader = response.headers.get("x-ratelimit-reset");
      const resetDelay =
        resetHeader === null ? 0 : Math.max(0, Number(resetHeader) * 1000 - Date.now());
      const errorBody = z.object({ message: z.string() }).safeParse(data);
      const limited =
        response.status === 429 ||
        (response.status === 403 &&
          (remaining === "0" ||
            retryAfter !== undefined ||
            (errorBody.success &&
              /(?:secondary )?rate limit|abuse detection/i.test(errorBody.data.message))));
      if (limited) {
        await sleepWithAbort(
          Math.max(
            1000,
            (retryAfter ?? 0) * 1000,
            Number.isFinite(resetDelay) ? resetDelay : 0,
            retryAfter === undefined && remaining !== "0" ? 60_000 : 0,
          ),
        );
        continue;
      }
      if (response.status >= 500 && failures < 3) {
        failures += 1;
        await sleepWithAbort(1000 * 2 ** (failures - 1));
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        // GitHub returns this 409 for an empty repository's commit list. Other
        // conflicts remain acquisition failures; never publish their partial counts.
        if (
          response.status === 409 &&
          /^repos\/[^/]+\/[^/]+\/commits$/u.test(url.pathname.slice(this.base.pathname.length)) &&
          errorBody.success &&
          errorBody.data.message === "Git Repository is empty."
        ) {
          return { data: [] };
        }
        throw new GithubHttpError(response.status);
      }
      const next = response.headers
        .get("link")
        ?.split(/,\s*(?=<)/)
        .find((part) => /;\s*rel="next"(?:;|\s*$)/i.test(part))
        ?.match(/^\s*<([^>]+)>/)?.[1];
      return { data, next: next ? new URL(next, url).href : undefined };
    }
  }

  async *pages<T>(
    path: string,
    schema: z.ZodType<T>,
    afterPage?: () => Promise<void>,
  ): AsyncGenerator<T> {
    let next: string | undefined = path;
    const seen = new Set<string>();
    while (next) {
      const canonical = this.url(next).href;
      if (seen.has(canonical)) {
        throw new GithubSourceError("API pagination did not advance");
      }
      seen.add(canonical);
      const page = await this.get(next);
      for (const item of parse(z.array(schema), page.data)) {
        yield item;
      }
      await afterPage?.();
      next = page.next;
    }
  }
}
