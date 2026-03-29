import type { JiraCloudConfig } from "./config.js";
import { JiraApiError } from "./errors.js";

type HttpMethod = "GET" | "POST" | "PUT";

type JiraRequestOptions = {
  method?: HttpMethod;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
};

type JiraClientDependencies = {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export class JiraCloudClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly authHeader: string;

  constructor(
    private readonly config: JiraCloudConfig,
    deps: JiraClientDependencies = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.sleepImpl = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.authHeader = `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString("base64")}`;
  }

  getSiteUrl(): string {
    return this.config.siteUrl;
  }

  getSecrets(): string[] {
    return [this.config.apiToken, `${this.config.email}:${this.config.apiToken}`, this.authHeader];
  }

  async request<T>(path: string, options: JiraRequestOptions = {}): Promise<T> {
    const method = options.method ?? "GET";
    const url = this.buildUrl(path, options.query);
    const maxAttempts = this.config.retryCount + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeoutMs = options.timeoutMs ?? this.config.requestTimeoutMs;
      const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          method,
          signal: controller.signal,
          headers: this.buildHeaders(options.body !== undefined),
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });

        if (response.ok) {
          if (response.status === 204) {
            return undefined as T;
          }
          return (await response.json()) as T;
        }

        const retryable = response.status === 429 || response.status >= 500;
        const error = await this.buildHttpError(response, retryable);
        if (!retryable || attempt >= maxAttempts) {
          throw error;
        }

        await this.sleepImpl(this.resolveBackoffMs(attempt, response));
      } catch (error) {
        if (!this.isRetryableTransportError(error) || attempt >= maxAttempts) {
          if (error instanceof JiraApiError) {
            throw error;
          }
          if (error instanceof DOMException && error.name === "AbortError") {
            throw new JiraApiError(
              `Jira request timed out after ${timeoutMs}ms.`,
              "jira_timeout",
              undefined,
              true,
            );
          }
          throw new JiraApiError(
            `Jira request failed: ${error instanceof Error ? error.message : String(error)}`,
            "jira_request_failed",
            undefined,
            false,
          );
        }
        await this.sleepImpl(this.resolveBackoffMs(attempt));
      } finally {
        clearTimeout(timeoutHandle);
      }
    }

    throw new JiraApiError("Unexpected Jira client state.", "jira_request_failed", undefined, false);
  }

  private buildUrl(path: string, query: JiraRequestOptions["query"]): string {
    const safePath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${this.config.siteUrl}${safePath}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) {
          continue;
        }
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private buildHeaders(hasBody: boolean): Headers {
    const headers = new Headers();
    headers.set("Accept", "application/json");
    headers.set("Authorization", this.authHeader);
    headers.set("User-Agent", this.config.userAgent);
    if (hasBody) {
      headers.set("Content-Type", "application/json");
    }
    return headers;
  }

  private async buildHttpError(response: Response, retryable: boolean): Promise<JiraApiError> {
    const detail = await this.readResponseDetail(response);
    if (response.status === 401 || response.status === 403) {
      return new JiraApiError(
        `Jira authentication failed (${response.status}).`,
        "jira_auth_failed",
        response.status,
        false,
      );
    }
    if (response.status === 400 || response.status === 404 || response.status === 409) {
      return new JiraApiError(
        `Jira validation failed (${response.status}): ${detail}`,
        "jira_validation_failed",
        response.status,
        false,
      );
    }
    if (response.status === 429) {
      return new JiraApiError(
        `Jira rate limited the request (429): ${detail}`,
        "jira_rate_limited",
        response.status,
        true,
      );
    }
    return new JiraApiError(
      `Jira request failed (${response.status}): ${detail}`,
      "jira_request_failed",
      response.status,
      retryable,
    );
  }

  private async readResponseDetail(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as {
        message?: string;
        errorMessages?: string[];
        errors?: Record<string, string>;
      };
      const messages: string[] = [];
      if (typeof body.message === "string" && body.message.trim()) {
        messages.push(body.message.trim());
      }
      if (Array.isArray(body.errorMessages)) {
        for (const message of body.errorMessages) {
          if (typeof message === "string" && message.trim()) {
            messages.push(message.trim());
          }
        }
      }
      if (body.errors && typeof body.errors === "object") {
        for (const [field, message] of Object.entries(body.errors)) {
          if (message) {
            messages.push(`${field}: ${message}`);
          }
        }
      }
      return messages.join("; ") || response.statusText || "Unknown Jira error";
    } catch {
      return response.statusText || "Unknown Jira error";
    }
  }

  private resolveBackoffMs(attempt: number, response?: Response): number {
    const retryAfter = response?.headers.get("retry-after");
    if (retryAfter) {
      const asNumber = Number(retryAfter);
      if (Number.isFinite(asNumber) && asNumber > 0) {
        return Math.min(2_000, Math.floor(asNumber * 1_000));
      }
    }
    return Math.min(2_000, 200 * 2 ** Math.max(0, attempt - 1));
  }

  private isRetryableTransportError(error: unknown): boolean {
    if (error instanceof JiraApiError) {
      return error.retryable;
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      return true;
    }
    if (!(error instanceof Error)) {
      return false;
    }
    return (
      error.name.includes("Timeout") ||
      error.message.includes("ECONNRESET") ||
      error.message.includes("ENOTFOUND") ||
      error.message.includes("network")
    );
  }
}

