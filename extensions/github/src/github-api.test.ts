import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGitHubApi, readGitHubGraphQLResponse, resolveGitHubApiUrls } from "./github-api.js";

const log = vi.hoisted(() => ({ info: vi.fn(), debug: vi.fn() }));
// mock-isolation: Capture severity without opening process-global log sinks.
vi.mock("openclaw/plugin-sdk/logging-core", () => ({ createSubsystemLogger: () => log }));

const publicRepo = "https://api.github.com/repos/acme/repo";
const query = { query: "query { viewer { login } }", variables: {} };
const quota = { statusCode: 429, retryAfterMs: 60_000 };
function scopedRequests(fetchImpl: typeof fetch, baseUrl: string) {
  return (url: string, token?: string, graphql?: Parameters<typeof fetchGitHubApi>[7]) =>
    fetchGitHubApi(
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
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it.each([false, true])("keeps slow fetch diagnostics at debug (failed=%s)", async (failed) => {
  vi.spyOn(performance, "now")
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(100)
    .mockReturnValueOnce(600);
  const fetchImpl = vi.fn<typeof fetch>();
  if (failed) {
    fetchImpl.mockRejectedValue(new Error("synthetic network failure"));
    await expect(fetchGitHubApi(publicRepo, fetchImpl)).rejects.toThrow("Could not reach GitHub");
  } else {
    fetchImpl.mockResolvedValue(new Response("{}"));
    await expect(fetchGitHubApi(publicRepo, fetchImpl)).resolves.toBeInstanceOf(Response);
  }
  expect(log.debug).toHaveBeenCalledWith("Slow GitHub API request", {
    authMs: 100,
    networkMs: 500,
    resource: "core",
    aborted: false,
  });
  expect(log.info).not.toHaveBeenCalled();
});

describe("GitHub API base URL", () => {
  it("defaults to public GitHub", async () => {
    const { GITHUB_API_BASE_URL, GITHUB_API_ORIGIN } = await import("../api.js");
    expect(GITHUB_API_BASE_URL).toBe("https://api.github.com");
    expect(GITHUB_API_ORIGIN).toBe("https://api.github.com");
  });

  it("routes Enterprise Server REST and GraphQL requests to their API paths", async () => {
    const { baseUrl, graphqlUrl } = resolveGitHubApiUrls("https://ghe.example.test/api/v3/");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    const request = scopedRequests(fetchImpl, baseUrl);
    await request(`${baseUrl}/repos/acme/private-repo`, "synthetic-token");
    await request(graphqlUrl, "synthetic-token", query);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://ghe.example.test/api/v3/repos/acme/private-repo",
      "https://ghe.example.test/api/graphql",
    ]);
    await expect(request("https://ghe.example.test/settings", "synthetic-token")).rejects.toThrow(
      "Invalid GitHub API URL",
    );
  });

  it("retains GraphQL quota on its admitted API while public requests are interleaved", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const enterpriseBase = "https://ghe.example.test/api/v3";
    const token = "synthetic-quota-token";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: [{ type: "RATE_LIMITED" }] }), { status: 403 }),
      )
      .mockImplementation(async () => new Response("{}"));
    const enterprise = scopedRequests(fetchImpl, enterpriseBase);
    const response = await enterprise(
      resolveGitHubApiUrls(enterpriseBase).graphqlUrl,
      token,
      query,
    );
    await expect(readGitHubGraphQLResponse(response, fetchImpl, token)).rejects.toMatchObject(
      quota,
    );
    await expect(fetchGitHubApi(publicRepo, fetchImpl, token)).resolves.toBeInstanceOf(Response);
    await expect(enterprise(`${enterpriseBase}/repos/acme/repo`, token)).rejects.toMatchObject(
      quota,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(
      enterprise(`${enterpriseBase}/repos/acme/repo`, "synthetic-rotated-token"),
    ).resolves.toBeInstanceOf(Response);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("keeps a configured HTTPS API port on Enterprise requests", async () => {
    const { baseUrl } = resolveGitHubApiUrls("https://ghe.example.test:8443/api/v3");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    const request = scopedRequests(fetchImpl, baseUrl);
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
  ])("rejects unsafe configured API origin %s", (origin) => {
    expect(() => resolveGitHubApiUrls(origin)).toThrow(
      "gateway.github.apiBaseUrl must be an HTTPS GitHub API base URL",
    );
  });
});
