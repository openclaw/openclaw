import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

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

afterEach(() => vi.restoreAllMocks());

describe("GitHub API base URL", () => {
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

it.each(["pending", "rejected"])(
  "reports GitHub rate limits when body cancellation is %s",
  async (cancellation) => {
    const cancel = vi.fn(() =>
      cancellation === "pending"
        ? new Promise<void>(() => {})
        : Promise.reject(new Error("synthetic cancellation failure")),
    );
    const response = new Response(new ReadableStream({ cancel }), {
      status: 429,
      headers: { "retry-after": "60" },
    });
    const api = await import("./github-api.js");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
    await expect(
      api.fetchGitHubApi("https://api.github.com/repos/acme/repo", fetcher),
    ).rejects.toMatchObject({
      statusCode: 429,
      upstreamStatus: 429,
      retryable: true,
    });
    expect(cancel).toHaveBeenCalledOnce();
  },
  10_000,
);

it("follows safe GitHub redirects and parses JSON while cancellation stays pending", async () => {
  const api = await import("./github-api.js");
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const beforeRedirect = vi.fn(async () => {});
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(new ReadableStream({ cancel }), {
        status: 301,
        headers: { location: "/repos/acme/renamed" },
      }),
    )
    .mockResolvedValueOnce(new Response('{"name":"renamed","private":false}'));
  const response = await api.fetchGitHubApi(
    "https://api.github.com/repos/acme/repo",
    fetcher,
    undefined,
    beforeRedirect,
  );
  expect(cancel).toHaveBeenCalledOnce();
  expect(beforeRedirect).toHaveBeenCalledExactlyOnceWith(
    new URL("https://api.github.com/repos/acme/renamed"),
  );
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "https://api.github.com/repos/acme/repo",
    "https://api.github.com/repos/acme/renamed",
  ]);
  await expect(api.readGitHubJsonResponse(response)).resolves.toEqual({
    name: "renamed",
    private: false,
  });
});

it("starts guarded resource release without awaiting cancellation and still awaits release", async () => {
  const guard = await import("openclaw/plugin-sdk/ssrf-runtime");
  const { loadGitHubImage } = await import("./image.js");
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const releaseStarted = Promise.withResolvers<void>();
  const releaseGate = Promise.withResolvers<void>();
  const release = vi.fn(() => {
    releaseStarted.resolve();
    return releaseGate.promise;
  });
  vi.spyOn(guard, "fetchWithSsrFGuard").mockResolvedValueOnce({
    response: new Response(new ReadableStream({ cancel }), { status: 404 }),
    finalUrl: "https://user-images.githubusercontent.com/synthetic.png",
    release,
  });
  let completed = false;
  const result = loadGitHubImage("https://user-images.githubusercontent.com/synthetic.png").finally(
    () => {
      completed = true;
    },
  );
  const rejection = expect(result).rejects.toThrow("GitHub image is unavailable");
  try {
    await releaseStarted.promise;
    // Let completion reactions drain while the release gate is still closed.
    await nextTurn();
    expect(cancel).toHaveBeenCalledOnce();
    expect(completed).toBe(false);
  } finally {
    releaseGate.resolve();
  }
  await rejection;
  expect(release).toHaveBeenCalledOnce();
});

it.each(["rate-limit", "redirect"])(
  "offline preview pipeline returns %s without waiting for discarded body cancellation",
  async (scenario) => {
    const { loadControlUiGitHubPreview } = await import("./preview.js");
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const discarded = new Response(new ReadableStream({ cancel }), {
      status: scenario === "rate-limit" ? 429 : 301,
      headers:
        scenario === "rate-limit"
          ? { "retry-after": "60" }
          : { location: "/repos/acme/renamed/issues/1" },
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("Unexpected offline GitHub request"))
      .mockResolvedValueOnce(discarded)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            title: "Synthetic issue",
            state: "open",
            user: { login: "synthetic-author" },
            created_at: "2026-10-01T00:00:00Z",
            updated_at: "2026-10-01T00:00:00Z",
          }),
        ),
      );
    const result = loadControlUiGitHubPreview(
      { kind: "issue", owner: "acme", repo: "rh109-" + scenario, number: 1 },
      undefined,
      fetcher,
    );
    if (scenario === "rate-limit") {
      await expect(result).rejects.toMatchObject({ statusCode: 429, upstreamStatus: 429 });
    } else {
      await expect(result).resolves.toMatchObject({
        title: "Synthetic issue",
        state: "open",
        login: "synthetic-author",
      });
    }
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(scenario === "rate-limit" ? 1 : 2);
  },
);
