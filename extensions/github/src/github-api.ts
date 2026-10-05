import { createHash } from "node:crypto";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import {
  createDiagnosticTraceContextFromActiveScope,
  createSubsystemLogger,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { parseRetryAfterHeaderSeconds } from "openclaw/plugin-sdk/retry-runtime";
import {
  asFiniteNumber,
  isRecord,
  parseStrictNonNegativeInteger,
  readNonBlankString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { createStageTimingTracker } from "openclaw/plugin-sdk/time-runtime";

export { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
// Shipped public constant names the default service, independent of the selected Enterprise API.
export const GITHUB_API_ORIGIN = DEFAULT_GITHUB_API_BASE_URL;

function resolveGitHubApiBaseUrl(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_GITHUB_API_BASE_URL;
  const parsed = new URL(raw);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !["/", "", "/api/v3", "/api/v3/"].includes(parsed.pathname)
  ) {
    throw new Error("gateway.github.apiBaseUrl must be an HTTPS GitHub API base URL");
  }
  return parsed.origin + (parsed.pathname.startsWith("/api/v3") ? "/api/v3" : "");
}

export const GITHUB_API_BASE_URL = DEFAULT_GITHUB_API_BASE_URL;
function githubGraphqlUrl(baseUrl: string): string {
  return baseUrl.endsWith("/api/v3") ? `${baseUrl.slice(0, -3)}/graphql` : `${baseUrl}/graphql`;
}

export const GITHUB_GRAPHQL_URL = githubGraphqlUrl(GITHUB_API_BASE_URL);

export function resolveGitHubApiUrls(apiBaseUrl: string | undefined) {
  const baseUrl = resolveGitHubApiBaseUrl(apiBaseUrl);
  return { baseUrl, graphqlUrl: githubGraphqlUrl(baseUrl) };
}

export function githubRestApiPath(url: URL, apiBaseUrl = GITHUB_API_BASE_URL): string {
  const basePath = new URL(apiBaseUrl).pathname;
  return url.pathname.slice(basePath === "/" ? 0 : basePath.length);
}
const GITHUB_JSON_MAX_BYTES = 256 * 1024;
export const GITHUB_REQUEST_TIMEOUT_MS = 8_000;
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_API_MAX_REDIRECTS = 3;
const GITHUB_QUOTA_CACHE_LIMIT = 200;
const GITHUB_QUOTA_RETRY_MS = 60_000;
const apiLog = createSubsystemLogger("github/api");

// Normal Gateway callers share global fetch; injected transports own separate
// API environments and release their cooldown state with that transport.
const transportCooldowns = new WeakMap<typeof fetch, Map<string, ControlUiGitHubError>>();
// Body-reported quotas belong to the admitted request even after API configuration changes.
export type GitHubUpstreamRequestScope = { signal: AbortSignal; release: () => void };
const responseRequestScopes = new WeakMap<
  Response,
  { credentialScope: string; fetchImpl: typeof fetch; resource: string }
>();
const responseCredentialScopes = new WeakMap<
  Response,
  { credentialScope: string; upstream?: GitHubUpstreamRequestScope }
>();

export class ControlUiGitHubError extends Error {
  readonly retryAtMs: number | undefined;
  readonly upstreamStatus: number;
  readonly retryable: boolean;

  // Messages are authored here or by the metadata parser, never upstream bodies.
  constructor(
    readonly statusCode: number,
    message: string,
    options: { retryAtMs?: number; upstreamStatus?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "ControlUiGitHubError";
    this.upstreamStatus = options.upstreamStatus ?? statusCode;
    this.retryAtMs = options.retryAtMs;
    this.retryable =
      options.retryable ??
      (statusCode === 429 ||
        (options.upstreamStatus !== undefined && options.upstreamStatus >= 500));
  }

  get retryAfterMs(): number | undefined {
    // Cached failures must keep the original reset time when a hovercard reopens.
    return this.retryAtMs === undefined ? undefined : Math.max(0, this.retryAtMs - Date.now());
  }
}

class ControlUiGitHubTransportError extends ControlUiGitHubError {
  constructor(message: string) {
    super(502, message, { retryable: true });
  }
}

export class GitHubGraphQLUnavailableError extends ControlUiGitHubError {
  constructor(upstreamStatus: number) {
    super(403, "GitHub GraphQL access is unavailable for the selected credential", {
      upstreamStatus,
      retryable: false,
    });
  }
}

export function formatControlUiGitHubPreviewError(error: unknown): {
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
} {
  if (error instanceof ControlUiGitHubTransportError) {
    return { message: `${error.message}. Retry or check GitHub availability.`, retryable: true };
  }
  if (error instanceof ControlUiGitHubError) {
    const status = `HTTP ${error.upstreamStatus}`;
    switch (error.statusCode) {
      case 401:
        return {
          message: `GitHub authentication failed (${status}). Reconnect the GitHub identity in Settings.`,
          retryable: false,
        };
      case 403:
        return {
          message: `GitHub access denied (${status}). Check the configured GitHub identity's repository access.`,
          retryable: false,
        };
      case 404:
        // The shared server credential must not reveal whether a private repository exists.
        return {
          message:
            "GitHub item is unavailable or not public (HTTP 404). Open the link on GitHub to check access.",
          retryable: false,
        };
      case 429: {
        const retryAfterMs = error.retryAfterMs;
        const wait =
          retryAfterMs === undefined ? "Wait" : `Wait ${Math.ceil(retryAfterMs / 1_000)} seconds`;
        return {
          message: `GitHub API rate limit exceeded (${status}). ${wait} and retry.`,
          retryable: true,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        };
      }
      case 502:
        return {
          message: `${error.message.slice(0, 256)}. Retry or check GitHub availability.`,
          retryable: true,
        };
    }
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return { message: "GitHub request timed out. Retry shortly.", retryable: true };
  }
  // Credential subprocess errors and arbitrary transport diagnostics can contain secrets.
  return {
    message: "GitHub preview could not be loaded. Retry or check the server logs.",
    retryable: false,
  };
}

export function githubApiCredentialCacheScope(token: string | undefined): string {
  return token ? createHash("sha256").update(token).digest("hex") : "anonymous";
}

export function requiredString(record: Record<string, unknown>, key: string): string {
  const value = readNonBlankString(record[key]);
  if (value === undefined) {
    throw new ControlUiGitHubError(502, `GitHub response omitted ${key}`);
  }
  return value;
}

export function readOptionalGitHubString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  return readNonBlankString(record[key]);
}

export function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  return asFiniteNumber(record[key]);
}

function githubApiResource(url: URL, apiBaseUrl: string, graphqlUrl: string): string {
  // GitHub separates GraphQL, code search, other searches, and non-search REST.
  const path = githubRestApiPath(url, apiBaseUrl);
  return url.href === graphqlUrl
    ? "graphql"
    : path === "/search/code"
      ? "code_search"
      : path.startsWith("/search/")
        ? "search"
        : "core";
}

function retainGitHubCooldown(
  fetchImpl: typeof fetch,
  credentialScope: string,
  resource: string,
  response: Response,
  error: ControlUiGitHubError,
): ControlUiGitHubError {
  const cooldowns = transportCooldowns.get(fetchImpl) ?? new Map<string, ControlUiGitHubError>();
  transportCooldowns.set(fetchImpl, cooldowns);
  // Exhausted primary quota is resource-specific; secondary limits can span APIs.
  const resourceKey =
    response.headers.get("x-ratelimit-remaining") === "0"
      ? (response.headers.get("x-ratelimit-resource") ?? resource)
      : "*";
  const key = `${credentialScope}:${resourceKey}`;
  const previous = activeGitHubCooldown(cooldowns, key);
  const retained =
    previous && (previous.retryAfterMs ?? 0) > (error.retryAfterMs ?? 0) ? previous : error;
  cooldowns.set(key, retained);
  pruneMapToMaxSize(cooldowns, GITHUB_QUOTA_CACHE_LIMIT);
  return retained;
}

function activeGitHubCooldown(
  cooldowns: Map<string, ControlUiGitHubError>,
  key: string,
): ControlUiGitHubError | undefined {
  const error = cooldowns.get(key);
  if (error && (error.retryAfterMs ?? 0) <= 0) {
    cooldowns.delete(key);
    return undefined;
  }
  return error;
}

function githubApiHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "OpenClaw-Control-UI",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function isGitHubApiRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function safeGitHubApiUrl(raw: string, apiBase: URL, graphqlUrl: string, base?: URL): URL | null {
  const url = URL.parse(raw, base);
  if (
    !url ||
    url.origin !== apiBase.origin ||
    url.username ||
    url.password ||
    (url.href !== graphqlUrl &&
      !url.pathname.startsWith(`${apiBase.pathname === "/" ? "" : apiBase.pathname}/`))
  ) {
    return null;
  }
  return url;
}

export async function fetchGitHubApi(
  rawUrl: string,
  fetchImpl: typeof fetch,
  token?: string,
  beforeRedirect?: (url: URL) => Promise<void>,
  identity?: {
    revalidate: () => Promise<void>;
    assertSelected: () => void;
    repository?: { owner: string; repo: string };
  },
  etag?: string,
  callerSignal?: AbortSignal | (() => GitHubUpstreamRequestScope),
  graphql?: { query: string; variables: Record<string, string> },
  apiBaseUrl = GITHUB_API_BASE_URL,
): Promise<Response> {
  if (typeof callerSignal !== "function") {
    callerSignal?.throwIfAborted();
  }
  const baseUrl = resolveGitHubApiBaseUrl(apiBaseUrl);
  const apiBase = new URL(baseUrl);
  const graphqlUrl = githubGraphqlUrl(baseUrl);
  const initialUrl = safeGitHubApiUrl(rawUrl, apiBase, graphqlUrl);
  if (!initialUrl) {
    throw new ControlUiGitHubError(502, "Invalid GitHub API URL");
  }
  if (graphql && (initialUrl.href !== graphqlUrl || !token || etag)) {
    throw new ControlUiGitHubError(502, "Invalid authenticated GitHub GraphQL request");
  }
  let url: URL = initialUrl;
  const credentialScope = `${baseUrl}:${githubApiCredentialCacheScope(token)}`;
  const cooldowns = transportCooldowns.get(fetchImpl) ?? new Map<string, ControlUiGitHubError>();
  transportCooldowns.set(fetchImpl, cooldowns);

  let timeout: AbortSignal | undefined;
  const trace = createDiagnosticTraceContextFromActiveScope();
  const timing = createStageTimingTracker(undefined, (phase) => {
    apiLog.info("github api phase", {
      traceId: trace.traceId,
      requestSpanId: trace.spanId,
      apiHost: apiBase.host,
      api: graphql ? "graphql" : "rest",
      ...phase,
    });
  });
  for (let redirects = 0; ; redirects += 1) {
    if (identity?.repository) {
      const repositoryPath =
        `/repos/${encodeURIComponent(identity.repository.owner)}/${encodeURIComponent(identity.repository.repo)}`.toLowerCase();
      const pathname = githubRestApiPath(url, baseUrl).toLowerCase();
      if (!token || (pathname !== repositoryPath && !pathname.startsWith(repositoryPath + "/"))) {
        throw new ControlUiGitHubError(404, "GitHub repository is outside the session");
      }
    }
    // Recheck every dispatch, including redirects and auxiliary metadata reads.
    // Selection must still be current after the asynchronous credential read.
    if (identity) {
      await timing.measure("credentialRevalidation", () => identity.revalidate());
      identity.assertSelected();
    }
    if (typeof callerSignal !== "function") {
      callerSignal?.throwIfAborted();
    }
    const resource = githubApiResource(url, baseUrl, graphqlUrl);
    const sharedCooldown = activeGitHubCooldown(cooldowns, `${credentialScope}:*`);
    const resourceCooldown = activeGitHubCooldown(cooldowns, `${credentialScope}:${resource}`);
    const cooldown =
      (sharedCooldown?.retryAfterMs ?? 0) > (resourceCooldown?.retryAfterMs ?? 0)
        ? sharedCooldown
        : resourceCooldown;
    if (cooldown) {
      throw cooldown;
    }
    // Admission and cooldown use their existing caller/authority bounds. One
    // transport deadline starts at first dispatch and survives redirects and body reads.
    const upstream = typeof callerSignal === "function" ? callerSignal() : undefined;
    const requestSignal =
      upstream?.signal ?? (typeof callerSignal === "function" ? undefined : callerSignal);
    timeout ??= AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
    const signal = requestSignal ? AbortSignal.any([timeout, requestSignal]) : timeout;
    let response: Response;
    try {
      signal.throwIfAborted();
      response = await timing.measure("responseHeaders", () =>
        fetchImpl(url.href, {
          headers: {
            ...githubApiHeaders(token),
            ...(etag ? { "If-None-Match": etag } : {}),
            ...(graphql ? { "Content-Type": "application/json" } : {}),
          },
          ...(graphql ? { method: "POST", body: JSON.stringify(graphql) } : {}),
          redirect: "manual",
          signal,
        }),
      );
    } catch (error) {
      upstream?.release();
      const timedOut = signal.aborted || (error instanceof Error && error.name === "TimeoutError");
      try {
        apiLog.info("github api failed", {
          traceId: trace.traceId,
          requestSpanId: trace.spanId,
          apiHost: apiBase.host,
          api: graphql ? "graphql" : "rest",
          diagnosticCode: timeout.aborted
            ? "deadline_expired"
            : requestSignal?.aborted
              ? "caller_aborted"
              : timedOut
                ? "transport_timeout"
                : "transport_error",
        });
      } catch {
        // Failure observation cannot replace transport settlement or its safe error.
      }
      throw new ControlUiGitHubTransportError(
        timedOut ? "GitHub request timed out" : "Could not reach GitHub",
      );
    }
    responseCredentialScopes.set(response, { credentialScope, upstream });
    if (isGitHubRateLimitResponse(response)) {
      const retained = retainGitHubCooldown(
        fetchImpl,
        credentialScope,
        resource,
        response,
        githubResponseError(response),
      );
      await discardResponse(response);
      throw retained;
    }
    if (!isGitHubApiRedirect(response.status)) {
      responseRequestScopes.set(response, { credentialScope, fetchImpl, resource });
      return response;
    }

    const location: string | null = response.headers.get("location");
    const nextUrl: URL | null = location
      ? safeGitHubApiUrl(location, apiBase, graphqlUrl, url)
      : null;
    if (!nextUrl || redirects >= GITHUB_API_MAX_REDIRECTS) {
      await discardResponse(response);
      throw new ControlUiGitHubError(502, "GitHub API returned an unsafe redirect");
    }
    // Credentials stay on the fixed API origin across GitHub redirects;
    // callers still verify the final response repository before returning it.
    await discardResponse(response);
    await beforeRedirect?.(nextUrl);
    if (graphql) {
      throw new ControlUiGitHubError(502, "GitHub GraphQL returned an unexpected redirect");
    }
    url = nextUrl;
  }
}

export async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel().catch(() => {});
  } finally {
    const scope = responseCredentialScopes.get(response);
    const upstream = scope?.upstream;
    if (scope) {
      scope.upstream = undefined;
    }
    upstream?.release();
  }
}

export async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  try {
    return await readResponseWithLimit(response, maxBytes, {
      onOverflow: () => new ControlUiGitHubError(502, "GitHub response exceeded the size limit"),
    });
  } finally {
    await discardResponse(response);
  }
}

// GitHub reports quota exhaustion as 429 or as 403 with exhausted-quota
// headers. Body-reported secondary limits are classified by the JSON reader;
// other 403 responses remain permission failures.
function isGitHubRateLimitResponse(response: Response): boolean {
  if (response.status === 429) {
    return true;
  }
  return (
    response.status === 403 &&
    (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after"))
  );
}

function githubResponseErrorStatus(response: Response): number {
  if (isGitHubRateLimitResponse(response)) {
    return 429;
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return response.status;
  }
  return 502;
}

function githubResponseError(response: Response, rateLimited = false): ControlUiGitHubError {
  const status = rateLimited ? 429 : githubResponseErrorStatus(response);
  let retryAtMs: number | undefined;
  if (status === 429) {
    const now = Date.now();
    const retrySeconds = parseRetryAfterHeaderSeconds(response.headers.get("retry-after"));
    // Reset headers describe primary quota even when a secondary limit rejects the request.
    const reset =
      response.headers.get("x-ratelimit-remaining") === "0"
        ? parseStrictNonNegativeInteger(response.headers.get("x-ratelimit-reset"))
        : undefined;
    const proposed =
      retrySeconds !== undefined
        ? now + retrySeconds * 1_000
        : reset !== undefined && reset <= Number.MAX_SAFE_INTEGER / 1_000
          ? reset * 1_000
          : undefined;
    retryAtMs =
      proposed !== undefined &&
      Number.isSafeInteger(proposed) &&
      Number.isFinite(new Date(proposed).getTime()) &&
      proposed > now
        ? proposed
        : now + GITHUB_QUOTA_RETRY_MS;
  }
  return new ControlUiGitHubError(status, `GitHub request failed (HTTP ${response.status})`, {
    upstreamStatus: response.status,
    retryAtMs,
  });
}

/** GraphQL can report failed queries and exhausted quota in an HTTP 200 response. */
export async function readGitHubGraphQLResponse(
  response: Response,
  fetchImpl: typeof fetch,
  token: string,
  maxBytes?: number,
): Promise<unknown> {
  const credentialScope =
    responseRequestScopes.get(response)?.credentialScope ??
    `${DEFAULT_GITHUB_API_BASE_URL}:${githubApiCredentialCacheScope(token)}`;
  const value =
    response.status === 403 && !isGitHubRateLimitResponse(response)
      ? await readGitHubJsonBody(response, maxBytes)
      : await readGitHubJsonResponse(response, maxBytes);
  const noData =
    isRecord(value) &&
    (value.data === undefined ||
      value.data === null ||
      (isRecord(value.data) && Object.values(value.data).every((field) => field === null)));
  if (isRecord(value) && value.errors !== undefined) {
    if (
      Array.isArray(value.errors) &&
      value.errors.some((error) => isRecord(error) && error.type === "RATE_LIMITED")
    ) {
      throw retainGitHubCooldown(
        fetchImpl,
        credentialScope,
        "graphql",
        response,
        githubResponseError(response, true),
      );
    }
    if (
      Array.isArray(value.errors) &&
      value.errors.length > 0 &&
      value.errors.every(
        (error) =>
          isRecord(error) && (error.type === "FORBIDDEN" || error.type === "INSUFFICIENT_SCOPES"),
      ) &&
      noData
    ) {
      throw new GitHubGraphQLUnavailableError(response.status);
    }
    if (!Array.isArray(value.errors) || value.errors.length > 0) {
      throw new ControlUiGitHubError(
        502,
        "GitHub GraphQL request failed; check repository access",
        {
          retryable: false,
        },
      );
    }
  }
  if (!response.ok) {
    if (
      response.status === 403 &&
      noData &&
      isRecord(value) &&
      value.errors === undefined &&
      (value.message === "Resource not accessible by integration" ||
        value.message === "Resource not accessible by personal access token")
    ) {
      throw new GitHubGraphQLUnavailableError(response.status);
    }
    throw githubResponseError(response);
  }
  return value;
}

// Optional host auth raises quota and unlocks private-repo reads, but an
// unusable credential must not disable public GitHub data that works anonymously.
export async function withOptionalGitHubAuth<T>(
  token: string | undefined,
  request: (token: string | undefined) => Promise<T>,
): Promise<T> {
  try {
    return await request(token);
  } catch (error) {
    const status = error instanceof ControlUiGitHubError ? error.statusCode : 0;
    if (token && [401, 403, 429].includes(status)) {
      try {
        return await request(undefined);
      } catch (anonymousError) {
        if (
          error instanceof ControlUiGitHubError &&
          error.statusCode === 429 &&
          anonymousError instanceof ControlUiGitHubError &&
          anonymousError.statusCode === 429 &&
          (error.retryAfterMs ?? Infinity) < (anonymousError.retryAfterMs ?? Infinity)
        ) {
          throw error;
        }
        throw anonymousError;
      }
    }
    throw error;
  }
}

export async function readGitHubJsonResponse(
  response: Response,
  maxBytes = GITHUB_JSON_MAX_BYTES,
): Promise<unknown> {
  if (!response.ok) {
    if (response.status === 403 && !isGitHubRateLimitResponse(response)) {
      let payload: unknown;
      try {
        payload = await readGitHubJsonBody(response, maxBytes);
      } catch {
        // An unreadable error body must not change a permission failure's status.
      }
      if (
        isRecord(payload) &&
        typeof payload.message === "string" &&
        /\b(?:secondary rate limit|abuse detection)\b/iu.test(payload.message)
      ) {
        const error = githubResponseError(response, true);
        const scope = responseRequestScopes.get(response);
        throw scope
          ? retainGitHubCooldown(
              scope.fetchImpl,
              scope.credentialScope,
              scope.resource,
              response,
              error,
            )
          : error;
      }
    }
    await discardResponse(response);
    throw githubResponseError(response);
  }
  return readGitHubJsonBody(response, maxBytes);
}

async function readGitHubJsonBody(
  response: Response,
  maxBytes = GITHUB_JSON_MAX_BYTES,
): Promise<unknown> {
  let body: Buffer;
  try {
    body = await readBoundedResponse(response, maxBytes);
  } catch (error) {
    if (error instanceof ControlUiGitHubError) {
      throw error;
    }
    throw new ControlUiGitHubError(502, "GitHub response could not be read");
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new ControlUiGitHubError(502, "GitHub response was not valid JSON");
  }
}

/** Fetch a GitHub API JSON document with bounded size and normalized errors. */
export function fetchGitHubJson(
  rawUrl: string,
  fetchImpl: typeof fetch,
  token?: string,
  maxBytes?: number,
  apiBaseUrl = GITHUB_API_BASE_URL,
  identity?: Parameters<typeof fetchGitHubApi>[4],
): Promise<unknown> {
  if (identity) {
    return fetchGitHubApi(
      rawUrl,
      fetchImpl,
      token,
      undefined,
      identity,
      undefined,
      undefined,
      undefined,
      apiBaseUrl,
    ).then((response) => readGitHubJsonResponse(response, maxBytes));
  }
  return withOptionalGitHubAuth(token, async (requestToken) =>
    readGitHubJsonResponse(
      await fetchGitHubApi(
        rawUrl,
        fetchImpl,
        requestToken,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        apiBaseUrl,
      ),
      maxBytes,
    ),
  );
}
