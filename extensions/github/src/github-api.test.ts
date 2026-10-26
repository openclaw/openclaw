import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGitHubApi, readGitHubGraphQLResponse, resolveGitHubApiUrls } from "./github-api.js";

const log = vi.hoisted(() => ({ info: vi.fn(), debug: vi.fn() }));
// mock-isolation: Capture severity without opening process-global log sinks.
vi.mock("openclaw/plugin-sdk/diagnostic-runtime", () => ({ createSubsystemLogger: () => log }));

const publicRepo = "https://api.github.com/repos/acme/repo";
const query = { query: "query { viewer { login } }", variables: {} };
const quota = { statusCode: 429, retryAfterMs: 60_000 };
function setup(base = "https://api.github.com") {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response("{}"));
  const request = (url: string, token?: string, gql?: Parameters<typeof fetchGitHubApi>[7]) =>
    fetchGitHubApi(url, fetcher, token, undefined, undefined, undefined, undefined, gql, base);
  return { fetcher, request };
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
  const { fetcher, request } = setup();
  if (failed) {
    fetcher.mockRejectedValue(new Error("synthetic network failure"));
    await expect(request(publicRepo)).rejects.toThrow("Could not reach GitHub");
  } else {
    await expect(request(publicRepo)).resolves.toBeInstanceOf(Response);
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
    expect({ GITHUB_API_BASE_URL, GITHUB_API_ORIGIN }).toEqual({
      GITHUB_API_BASE_URL: "https://api.github.com",
      GITHUB_API_ORIGIN: "https://api.github.com",
    });
  });

  it.each([
    ["https://ghe.example.test/api/v3/", "https://ghe.example.test/api/v3"],
    ["https://ghe.example.test:8443/api/v3", "https://ghe.example.test:8443/api/v3"],
  ])("routes Enterprise REST and GraphQL within %s", async (configured, expected) => {
    const { baseUrl, graphqlUrl } = resolveGitHubApiUrls(configured);
    const { fetcher, request } = setup(baseUrl);
    await request(`${baseUrl}/repos/acme/private-repo`, "synthetic-token");
    await request(graphqlUrl, "synthetic-token", query);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `${expected}/repos/acme/private-repo`,
      expected.replace("/api/v3", "/api/graphql"),
    ]);
    expect(fetcher).toHaveBeenCalledWith(`${expected}/repos/acme/private-repo`, expect.any(Object));
    await expect(request("https://ghe.example.test/settings", "synthetic-token")).rejects.toThrow(
      "Invalid GitHub API URL",
    );
    if (configured.includes(":8443")) {
      await expect(
        request("https://ghe.example.test/api/v3/repos/acme/private-repo"),
      ).rejects.toThrow("Invalid GitHub API URL");
    }
  });

  it("retains GraphQL quota per admitted API and credential across interleaved requests", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const base = "https://ghe.example.test/api/v3";
    const token = "synthetic-quota-token";
    const { fetcher, request } = setup(base);
    fetcher.mockResolvedValueOnce(
      Response.json({ errors: [{ type: "RATE_LIMITED" }] }, { status: 403 }),
    );
    const response = await request(resolveGitHubApiUrls(base).graphqlUrl, token, query);
    await expect(readGitHubGraphQLResponse(response, fetcher, token)).rejects.toMatchObject(quota);
    await expect(fetchGitHubApi(publicRepo, fetcher, token)).resolves.toBeInstanceOf(Response);
    await expect(request(`${base}/repos/acme/repo`, token)).rejects.toMatchObject(quota);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(
      request(`${base}/repos/acme/repo`, "synthetic-rotated-token"),
    ).resolves.toBeInstanceOf(Response);
    expect(fetcher).toHaveBeenCalledTimes(3);
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
