import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const phaseLog = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/diagnostic-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/diagnostic-runtime")>()),
  createSubsystemLogger: () => ({ info: phaseLog }),
}));

function scopedRequests(
  api: typeof import("./github-api.js"),
  fetchImpl: typeof fetch,
  baseUrl: string,
) {
  return (url: string, token?: string, graphql?: Parameters<typeof api.fetchGitHubApi>[7]) =>
    api.fetchGitHubApi(
      url,
      fetchImpl,
      token,
      undefined,
      undefined,
      undefined,
      undefined,
      graphql,
      baseUrl,
    );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function useRequestClock() {
  vi.useFakeTimers();
  phaseLog.mockReset();
  // Native AbortSignal timers do not use Vitest's deterministic clock.
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
    return controller.signal;
  });
}

function requestSignal(init: RequestInit | undefined): AbortSignal {
  if (!init?.signal) {
    throw new Error("Fixture requires a cancellable transport");
  }
  return init.signal;
}

describe("GitHub API base URL", () => {
  it.each(["admission", "transport"] as const)(
    "observes pending %s and its error without exporting private diagnostics",
    async (failureStage) => {
      const api = await import("./github-api.js");
      phaseLog.mockReset();
      const entered = createDeferred<void>();
      const admitted = createDeferred<void>();
      const transported = createDeferred<Response>();
      const transportEntered = createDeferred<void>();
      const privateError = new Error("synthetic-private-token-and-request-body");
      const fetchImpl = vi.fn<typeof fetch>(async () => {
        transportEntered.resolve();
        return await transported.promise;
      });
      const request = api.fetchGitHubApi(
        "https://api.github.com/repos/acme/private-repo?private-query=secret",
        fetchImpl,
        "synthetic-private-token",
        undefined,
        {
          revalidate: async () => {
            entered.resolve();
            await admitted.promise;
          },
          assertSelected: vi.fn(),
        },
      );
      const outcome = request.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await entered.promise;
      try {
        expect(phaseLog).toHaveBeenCalledWith(
          "github api phase",
          expect.objectContaining({
            traceId: expect.stringMatching(/^[a-f0-9]{32}$/u),
            name: "credentialRevalidation",
            status: "entry",
          }),
        );
        expect(fetchImpl).not.toHaveBeenCalled();
        if (failureStage === "admission") {
          admitted.reject(privateError);
        } else {
          admitted.resolve();
          await transportEntered.promise;
          expect(phaseLog).toHaveBeenCalledWith(
            "github api phase",
            expect.objectContaining({ name: "credentialRevalidation", status: "success" }),
          );
          expect(phaseLog).toHaveBeenCalledWith(
            "github api phase",
            expect.objectContaining({ name: "responseHeaders", status: "entry" }),
          );
          transported.reject(privateError);
        }
      } finally {
        admitted.reject(privateError);
        transported.resolve(new Response("{}"));
        await outcome;
      }
      const result = await outcome;
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("Failed GitHub request unexpectedly succeeded");
      }
      expect(result.error).toMatchObject({
        message: failureStage === "admission" ? privateError.message : "Could not reach GitHub",
      });
      const records = phaseLog.mock.calls.map(([, fields]) => fields);
      const failedName =
        failureStage === "admission" ? "credentialRevalidation" : "responseHeaders";
      const entry = records.find(
        (record) => record.name === failedName && record.status === "entry",
      );
      expect(records).toContainEqual(
        expect.objectContaining({
          traceId: entry.traceId,
          requestSpanId: entry.requestSpanId,
          name: failedName,
          spanId: entry.spanId,
          status: "error",
          durationMs: expect.any(Number),
        }),
      );
      if (failureStage === "transport") {
        expect(phaseLog).toHaveBeenCalledWith(
          "github api failed",
          expect.objectContaining({
            traceId: entry.traceId,
            requestSpanId: entry.requestSpanId,
            diagnosticCode: "transport_error",
          }),
        );
      }
      expect(JSON.stringify(records)).not.toMatch(/private-repo|private-query|secret|token|body/);
    },
  );

  it("honors caller cancellation while current authority is being revalidated", async () => {
    const api = await import("./github-api.js");
    phaseLog.mockImplementationOnce(() => {
      throw new Error("diagnostic sink unavailable");
    });
    const entered = createDeferred<void>();
    const admitted = createDeferred<void>();
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    const request = api.fetchGitHubApi(
      "https://api.github.com/repos/acme/repo",
      fetchImpl,
      "synthetic-token",
      undefined,
      {
        revalidate: async () => {
          entered.resolve();
          await admitted.promise;
        },
        assertSelected: vi.fn(),
      },
      undefined,
      controller.signal,
    );
    const cancelled = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await entered.promise;
    controller.abort();
    admitted.resolve();
    await cancelled;
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("defaults to public GitHub", async () => {
    const { GITHUB_API_BASE_URL, GITHUB_API_ORIGIN } = await import("../api.js");
    expect(GITHUB_API_BASE_URL).toBe("https://api.github.com");
    expect(GITHUB_API_ORIGIN).toBe("https://api.github.com");
  });

  it("routes Enterprise Server REST and GraphQL requests to their API paths", async () => {
    const api = await import("./github-api.js");
    const { baseUrl, graphqlUrl } = api.resolveGitHubApiUrls("https://ghe.example.test/api/v3/");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    const request = scopedRequests(api, fetchImpl, baseUrl);
    await request(`${baseUrl}/repos/acme/private-repo`, "synthetic-token");
    await request(graphqlUrl, "synthetic-token", {
      query: "query { viewer { login } }",
      variables: {},
    });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://ghe.example.test/api/v3/repos/acme/private-repo",
      "https://ghe.example.test/api/graphql",
    ]);
    await expect(request("https://ghe.example.test/settings", "synthetic-token")).rejects.toThrow(
      "Invalid GitHub API URL",
    );
  });

  it("retains GraphQL quota on its admitted API while public requests are interleaved", async () => {
    const api = await import("./github-api.js");
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const enterpriseBase = "https://ghe.example.test/api/v3";
    const token = "synthetic-quota-token";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: [{ type: "RATE_LIMITED" }] }), { status: 403 }),
      )
      .mockImplementation(async () => new Response("{}"));
    const enterprise = scopedRequests(api, fetchImpl, enterpriseBase);
    const response = await enterprise(api.resolveGitHubApiUrls(enterpriseBase).graphqlUrl, token, {
      query: "query { viewer { login } }",
      variables: {},
    });
    await expect(api.readGitHubGraphQLResponse(response, fetchImpl, token)).rejects.toMatchObject({
      statusCode: 429,
      retryAfterMs: 60_000,
    });
    await expect(
      api.fetchGitHubApi("https://api.github.com/repos/acme/repo", fetchImpl, token),
    ).resolves.toBeInstanceOf(Response);
    await expect(enterprise(`${enterpriseBase}/repos/acme/repo`, token)).rejects.toMatchObject({
      statusCode: 429,
      retryAfterMs: 60_000,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(
      enterprise(`${enterpriseBase}/repos/acme/repo`, "synthetic-rotated-token"),
    ).resolves.toBeInstanceOf(Response);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("keeps a configured HTTPS API port on Enterprise requests", async () => {
    const api = await import("./github-api.js");
    const { baseUrl } = api.resolveGitHubApiUrls("https://ghe.example.test:8443/api/v3");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    const request = scopedRequests(api, fetchImpl, baseUrl);
    await request(`${baseUrl}/repos/acme/private-repo`);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://ghe.example.test:8443/api/v3/repos/acme/private-repo",
      expect.any(Object),
    );
    await expect(
      request("https://ghe.example.test/api/v3/repos/acme/private-repo"),
    ).rejects.toThrow("Invalid GitHub API URL");
  });

  it.each([
    "http://api.ghe.example.test",
    "https://user@example.com",
    "https://api.ghe.example.test/other",
  ])("rejects unsafe configured API origin %s", async (origin) => {
    const api = await import("./github-api.js");
    expect(() => api.resolveGitHubApiUrls(origin)).toThrow(
      "gateway.github.apiBaseUrl must be an HTTPS GitHub API base URL",
    );
  });
});

describe("GitHub transport deadline", () => {
  it.each(["rest", "graphql", "lazy upstream"] as const)(
    "preserves the full HTTP budget after bounded slow admission for %s",
    async (kind) => {
      const api = await import("./github-api.js");
      useRequestClock();
      const admissionEntered = createDeferred<void>();
      const admitted = createDeferred<void>();
      const transportEntered = createDeferred<void>();
      const caller = new AbortController();
      const released = vi.fn();
      const upstream = vi.fn(() => ({ signal: caller.signal, release: released }));
      const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
        transportEntered.resolve();
        const signal = requestSignal(init);
        signal.throwIfAborted();
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Request aborted", "AbortError")),
            { once: true },
          );
        });
      });
      const settled = vi.fn();
      const pending = api
        .fetchGitHubApi(
          kind === "graphql"
            ? api.GITHUB_GRAPHQL_URL
            : `${api.GITHUB_API_BASE_URL}/repos/acme/repo`,
          fetchImpl,
          "synthetic-deadline-token",
          undefined,
          {
            revalidate: async () => {
              admissionEntered.resolve();
              await admitted.promise;
            },
            assertSelected: () => {},
          },
          undefined,
          kind === "lazy upstream" ? upstream : caller.signal,
          kind === "graphql" ? { query: "query { viewer { login } }", variables: {} } : undefined,
        )
        .then(
          (response) => settled({ response }),
          (error: unknown) => settled({ error }),
        );
      try {
        await admissionEntered.promise;
        await vi.advanceTimersByTimeAsync(9_000);
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(upstream).not.toHaveBeenCalled();
        admitted.resolve();
        await transportEntered.promise;
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(7_999);
        expect(settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await pending;
        expect(settled).toHaveBeenCalledExactlyOnceWith({
          error: expect.objectContaining({ statusCode: 502, retryable: true }),
        });
        // A post-send timeout retains its failure; it neither proves no effects nor retries.
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(phaseLog).toHaveBeenCalledWith(
          "github api failed",
          expect.objectContaining({
            diagnosticCode: "deadline_expired",
          }),
        );
        expect(released).toHaveBeenCalledTimes(kind === "lazy upstream" ? 1 : 0);
      } finally {
        admitted.resolve();
        caller.abort();
        await pending;
      }
    },
  );

  it.each(["headers", "body"] as const)(
    "preserves caller cancellation and scope release during transport %s",
    async (stage) => {
      const api = await import("./github-api.js");
      useRequestClock();
      const sent = createDeferred<void>();
      const caller = new AbortController();
      const release = vi.fn();
      const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
        const signal = requestSignal(init);
        signal.throwIfAborted();
        sent.resolve();
        if (stage === "body") {
          return new Response(
            new ReadableStream({
              start(controller) {
                signal.addEventListener("abort", () => controller.error(signal.reason), {
                  once: true,
                });
              },
            }),
          );
        }
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Request aborted", "AbortError")),
            { once: true },
          );
        });
      });
      const pending = api
        .fetchGitHubApi(
          `${api.GITHUB_API_BASE_URL}/repos/acme/repo`,
          fetchImpl,
          "synthetic-caller-token",
          undefined,
          undefined,
          undefined,
          () => ({ signal: caller.signal, release }),
        )
        .then((response) => api.readBoundedResponse(response, 1024));
      const cancelled = expect(pending).rejects.toBeInstanceOf(Error);
      try {
        await sent.promise;
        await vi.advanceTimersByTimeAsync(1_000);
        caller.abort(new DOMException("synthetic-private-cancel-reason", "AbortError"));
        await cancelled;
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
        if (stage === "headers") {
          expect(phaseLog).toHaveBeenCalledWith(
            "github api failed",
            expect.objectContaining({
              diagnosticCode: "caller_aborted",
            }),
          );
        }
        expect(JSON.stringify(phaseLog.mock.calls)).not.toContain(
          "synthetic-private-cancel-reason",
        );
      } finally {
        caller.abort();
        await cancelled;
      }
    },
  );

  it.each(["headers", "body", "redirect admission"] as const)(
    "retains one dispatch deadline across redirects and %s",
    async (stage) => {
      const api = await import("./github-api.js");
      useRequestClock();
      const firstEntered = createDeferred<void>();
      const firstHeaders = createDeferred<Response>();
      const secondEntered = createDeferred<void>();
      const redirectAdmission = createDeferred<void>();
      const caller = new AbortController();
      let admissions = 0;
      const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
        const signal = requestSignal(init);
        signal.throwIfAborted();
        if (fetchImpl.mock.calls.length === 1) {
          firstEntered.resolve();
          return await firstHeaders.promise;
        }
        secondEntered.resolve();
        if (stage === "body") {
          return new Response(
            new ReadableStream({
              start(controller) {
                signal.addEventListener("abort", () => controller.error(signal.reason), {
                  once: true,
                });
              },
            }),
          );
        }
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Request aborted", "AbortError")),
            { once: true },
          );
        });
      });
      const settled = vi.fn();
      const pending = api
        .fetchGitHubApi(
          `${api.GITHUB_API_BASE_URL}/repos/acme/repo`,
          fetchImpl,
          "synthetic-redirect-token",
          undefined,
          {
            revalidate: async () => {
              admissions++;
              if (stage === "redirect admission" && admissions === 2) {
                secondEntered.resolve();
                await redirectAdmission.promise;
              }
            },
            assertSelected: () => {},
          },
          undefined,
          caller.signal,
        )
        .then((response) => api.readBoundedResponse(response, 1024))
        .then(
          (body) => settled({ body }),
          (error: unknown) => settled({ error }),
        );
      try {
        await firstEntered.promise;
        await vi.advanceTimersByTimeAsync(5_000);
        firstHeaders.resolve(
          new Response(null, {
            status: 302,
            headers: {
              location: `${api.GITHUB_API_BASE_URL}/repos/acme/moved`,
            },
          }),
        );
        await secondEntered.promise;
        await vi.advanceTimersByTimeAsync(2_999);
        expect(settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        redirectAdmission.resolve();
        await pending;
        expect(settled).toHaveBeenCalledExactlyOnceWith({ error: expect.any(Error) });
        expect(admissions).toBe(2);
        expect(fetchImpl).toHaveBeenCalledTimes(stage === "redirect admission" ? 1 : 2);
        if (stage !== "redirect admission") {
          expect(requestSignal(fetchImpl.mock.calls[1]?.[1]).aborted).toBe(true);
        }
      } finally {
        firstHeaders.resolve(
          new Response(null, {
            status: 302,
            headers: {
              location: `${api.GITHUB_API_BASE_URL}/repos/acme/moved`,
            },
          }),
        );
        redirectAdmission.resolve();
        caller.abort();
        await pending;
      }
    },
  );

  it.each(["credential", "selection"] as const)(
    "does not send HTTP when %s authority changes during admission",
    async (stage) => {
      const api = await import("./github-api.js");
      const entered = createDeferred<void>();
      const admitted = createDeferred<void>();
      const refused = new Error("Synthetic authority retired");
      let current = true;
      const fetchImpl = vi.fn<typeof fetch>();
      const upstream = vi.fn(() => ({ signal: new AbortController().signal, release: vi.fn() }));
      const pending = api.fetchGitHubApi(
        `${api.GITHUB_API_BASE_URL}/repos/acme/repo`,
        fetchImpl,
        "synthetic-guard-token",
        undefined,
        {
          revalidate: async () => {
            entered.resolve();
            await admitted.promise;
            if (stage === "credential" && !current) {
              throw refused;
            }
          },
          assertSelected: () => {
            if (!current) {
              throw refused;
            }
          },
        },
        undefined,
        upstream,
      );
      const denied = expect(pending).rejects.toBe(refused);
      await entered.promise;
      current = false;
      admitted.resolve();
      await denied;
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(upstream).not.toHaveBeenCalled();
    },
  );
});
