import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
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

describe("GitHub discardResponse hanging-body HTTP transport", () => {
  it("returns from discardResponse while retained unread cancel stays pending", async () => {
    const { createServer } = await import("node:http");
    const api = await import("./github-api.js");
    const socketClosed = createDeferred<void>();
    const server = createServer((req, res) => {
      res.writeHead(429, {
        "content-type": "application/json",
        connection: "close",
        "retry-after": "1",
      });
      // Leave the body unread/hanging so await cancel would stall with a retained tee.
      res.write('{"message":"rate limited"');
      req.socket?.once("close", () => {
        socketClosed.resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });

    let retained: Response | undefined;
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP address");
      }
      const response = await fetch(`http://127.0.0.1:${address.port}/rate-limit`);
      // Retain an unread clone so body.cancel() can remain pending (capture-tee case).
      retained = response.clone();
      const returned = createDeferred<void>();
      const discardPromise = api.discardResponse(response).then(() => {
        returned.resolve();
      });
      await returned.promise;

      const cancelPending = retained.body?.cancel() ?? Promise.resolve();
      let cancelSettled = false;
      void cancelPending.then(
        () => {
          cancelSettled = true;
        },
        () => {
          cancelSettled = true;
        },
      );
      await Promise.resolve();
      console.log(
        `[github discardResponse HTTP transport proof] returned=true cancel_pending=${!cancelSettled}`,
      );
      expect(cancelSettled).toBe(false);

      await cancelPending.catch(() => undefined);
      await discardPromise;
      await socketClosed.promise;
    } finally {
      if (retained && !retained.bodyUsed) {
        void retained.body?.cancel().catch(() => undefined);
      }
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });
});
