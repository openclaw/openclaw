export type MediaFetchAttempt = {
  url: string;
  method: string;
  cache: RequestCache;
  mode: RequestMode;
  credentials: RequestCredentials;
  authorizationContext: number;
  outcome: "pending" | "fulfilled" | "rejected";
  status?: number;
};

export type MediaConsoleError = {
  type: string;
  message: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
};

export type MediaFailedRequest = {
  url: string;
  method: string;
  resourceType: string;
  errorText: string;
};

export function classifyMediaErrors(input: {
  engine: string;
  origin: string;
  pageErrors: string[];
  httpErrors: string[];
  consoleErrors: MediaConsoleError[];
  failedRequests: MediaFailedRequest[];
  fetchAttempts: MediaFetchAttempt[];
}) {
  const expectedUrls = new Set<string>();
  if (input.engine === "webkit") {
    const attemptsByUrl = Map.groupBy(
      input.fetchAttempts.filter(
        (attempt) =>
          attempt.method === "GET" &&
          attempt.mode === "same-origin" &&
          attempt.cache === "only-if-cached" &&
          attempt.outcome === "rejected",
      ),
      (attempt) => attempt.url,
    );
    const failuresByUrl = Map.groupBy(input.failedRequests, (request) => request.url);
    const consoleByUrl = Map.groupBy(input.consoleErrors, (error) => error.url);
    for (const [url, attempts] of attemptsByUrl) {
      const parsed = new URL(url);
      const failures = failuresByUrl.get(url) ?? [];
      const errors = consoleByUrl.get(url) ?? [];
      // Require complete URL multisets; an ambiguous extra failure remains fatal.
      if (
        parsed.origin === input.origin &&
        /\/(?:__openclaw__\/(?:assistant-media|link-favicon)|api\/users\/[^/]+\/avatar)/u.test(
          parsed.pathname,
        ) &&
        attempts.length === failures.length &&
        attempts.length === errors.length &&
        failures.every((request) => request.method === "GET" && request.resourceType === "fetch") &&
        errors.every(
          (error) =>
            error.type === "error" &&
            error.message === "Failed to load resource: resource unavailable",
        )
      ) {
        expectedUrls.add(url);
      }
    }
  }
  return {
    expectedCacheMisses: input.consoleErrors.filter((error) => expectedUrls.has(error.url)),
    unexpectedErrors: [
      ...input.pageErrors,
      ...input.httpErrors,
      ...input.consoleErrors
        .filter((error) => !expectedUrls.has(error.url))
        .map((error) => error.message),
      ...input.failedRequests
        .filter((request) => !expectedUrls.has(request.url))
        .map((request) => `Request failed: ${request.method} ${request.url} ${request.errorText}`),
    ],
  };
}
