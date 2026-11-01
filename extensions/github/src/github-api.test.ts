import { afterEach, expect, it, vi } from "vitest";
import {
  fetchGitHubApi,
  fetchGitHubJson,
  fetchGitHubJsonPage,
  readGitHubGraphQLResponse,
  resolveGitHubApiUrls,
} from "./github-api.js";

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

it("keeps slow failed-fetch diagnostics at debug", async () => {
  vi.spyOn(performance, "now")
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(100)
    .mockReturnValueOnce(600);
  const { fetcher, request } = setup();
  fetcher.mockRejectedValue(new Error("synthetic network failure"));
  await expect(request(publicRepo)).rejects.toThrow("Could not reach GitHub");
  expect(log.debug).toHaveBeenCalledOnce();
  expect(log.info).not.toHaveBeenCalled();
});

it("normalizes Enterprise REST and GraphQL URLs while preserving the port", async () => {
  const expected = "https://ghe.example.test:8443/api/v3";
  const { baseUrl, graphqlUrl } = resolveGitHubApiUrls(expected + "/");
  const { fetcher, request } = setup(baseUrl);
  await request(`${baseUrl}/repos/acme/private-repo`, "synthetic-token");
  await request(graphqlUrl, "synthetic-token", query);
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    `${expected}/repos/acme/private-repo`,
    expected.replace("/api/v3", "/api/graphql"),
  ]);
  await expect(request("https://ghe.example.test/settings", "synthetic-token")).rejects.toThrow(
    "Invalid GitHub API URL",
  );
  await expect(request("https://ghe.example.test/api/v3/repos/acme/private-repo")).rejects.toThrow(
    "Invalid GitHub API URL",
  );
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

it("revalidates interleaved credentials and pages without transferring or decoding unchanged bodies", async () => {
  const bodies = new Map<string, string>();
  let bytes = 0;
  let charged = 0;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const headers = new Headers(init?.headers);
    const token = headers.get("authorization") ?? "anonymous";
    const rawUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const key = `${rawUrl}:${token}`;
    const body = bodies.get(key) ?? JSON.stringify({ token, nested: { items: [1, 2] } });
    const etag = `"${body.length}-${token}"`;
    if (headers.get("if-none-match") === etag) {
      if (!headers.has("authorization")) {
        charged += 1;
      }
      return new Response(null, { status: 304 });
    }
    bytes += Buffer.byteLength(body);
    charged += 1;
    return new Response(body, { headers: { etag, link: '<next>; rel="next"' } });
  });
  const read = (token?: string, url = publicRepo, maxBytes?: number) =>
    fetchGitHubJson(url, fetcher, token, maxBytes);
  const first = await read("synthetic-a");
  const other = await read("synthetic-b");
  const anonymous = await read();
  const otherUrl = await read("synthetic-a", publicRepo + "/pulls");
  const transferred = bytes;
  const parse = vi.spyOn(JSON, "parse");
  expect(await read("synthetic-a")).toBe(first);
  expect(await read("synthetic-b")).toBe(other);
  expect(await read()).toBe(anonymous);
  expect(await read("synthetic-a", publicRepo + "/pulls")).toBe(otherUrl);
  expect(parse).not.toHaveBeenCalled();
  expect(bytes).toBe(transferred);
  expect(charged).toBe(5);
  expect(fetcher).toHaveBeenCalledTimes(8);
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen((first as { nested: unknown }).nested)).toBe(true);
  await expect(read("synthetic-a", publicRepo, 1)).rejects.toThrow("size limit");
  bodies.set(`${publicRepo}:Bearer synthetic-a`, '{"changed":true}');
  expect(await read("synthetic-a")).toEqual({ changed: true });
});

it("keeps dispatch authority, revocation and redirects live on a cached page", async () => {
  let allowed = true;
  let upstreamStatus = 200;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (upstreamStatus === 302) {
      upstreamStatus = 200;
      return new Response(null, { status: 302, headers: { location: publicRepo + "-renamed" } });
    }
    if (upstreamStatus !== 200) {
      return new Response(null, { status: upstreamStatus });
    }
    return new Headers(init?.headers).has("if-none-match")
      ? new Response(null, { status: 304 })
      : Response.json(
          { private: false },
          { headers: { etag: '"v1"', link: '<next>; rel="next"' } },
        );
  });
  const revalidate = vi.fn(async () => {});
  const assertSelected = () => {
    if (!allowed) {
      throw new Error("identity revoked");
    }
  };
  const read = (beforeRedirect?: (url: URL) => Promise<void>) =>
    fetchGitHubJsonPage(publicRepo, fetcher, "synthetic-a", {
      identity: { revalidate, assertSelected },
      beforeRedirect,
    });
  const initial = await read();
  const unchanged = await read();
  expect(unchanged.value).toBe(initial.value);
  expect(unchanged.link).toBe('<next>; rel="next"');
  allowed = false;
  await expect(read()).rejects.toThrow("identity revoked");
  expect(fetcher).toHaveBeenCalledTimes(2);
  allowed = true;
  await read();
  upstreamStatus = 403;
  await expect(read()).rejects.toMatchObject({ statusCode: 403 });
  upstreamStatus = 200;
  await read();
  expect(new Headers(fetcher.mock.calls.at(-1)?.[1]?.headers).has("if-none-match")).toBe(false);
  upstreamStatus = 302;
  const redirect = vi.fn(async () => {});
  await read(redirect);
  expect(redirect).toHaveBeenCalledOnce();
  expect(new Headers(fetcher.mock.calls.at(-1)?.[1]?.headers).has("if-none-match")).toBe(false);
  await read();
  expect(new Headers(fetcher.mock.calls.at(-1)?.[1]?.headers).has("if-none-match")).toBe(false);
});

it("bounds retained pages and never retains malformed JSON", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({}, { headers: { etag: '"v1"' } }));
  for (let id = 0; id < 129; id++) {
    await fetchGitHubJsonPage(`${publicRepo}/${id}`, fetcher);
  }
  await fetchGitHubJsonPage(`${publicRepo}/0`, fetcher);
  expect(new Headers(fetcher.mock.calls.at(-1)?.[1]?.headers).has("if-none-match")).toBe(false);
  fetcher.mockResolvedValueOnce(new Response("{", { headers: { etag: '"bad"' } }));
  await expect(fetchGitHubJsonPage(publicRepo, fetcher)).rejects.toThrow("not valid JSON");
  await fetchGitHubJsonPage(publicRepo, fetcher);
  expect(new Headers(fetcher.mock.calls.at(-1)?.[1]?.headers).has("if-none-match")).toBe(false);
});

it.each([undefined, "no-store"])(
  "does not reuse pages without a validator or with %s",
  async (cacheControl) => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(
        { value: 1 },
        {
          headers: cacheControl ? { etag: '"v1"', "cache-control": cacheControl } : {},
        },
      ),
    );
    await fetchGitHubJsonPage(publicRepo, fetcher);
    await fetchGitHubJsonPage(publicRepo, fetcher);
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).has("if-none-match")).toBe(false);
  },
);

it("keeps byte accounting exact when same-resource body reads overlap", async () => {
  const body = JSON.stringify({ payload: "x".repeat(5 * 1024 * 1024) });
  const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
    new Headers(init?.headers).has("if-none-match")
      ? new Response(null, { status: 304 })
      : new Response(body, { headers: { etag: '"large"' } }),
  );
  const read = () =>
    fetchGitHubJsonPage(publicRepo, fetcher, undefined, { maxBytes: 6 * 1024 * 1024 });
  await Promise.all([read(), read()]);
  await read();
  expect(new Headers(fetcher.mock.calls[2]?.[1]?.headers).get("if-none-match")).toBe('"large"');
});

it("updates supplied 304 pagination metadata while retaining omitted metadata", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json([], { headers: { etag: '"page"' } }))
    .mockResolvedValueOnce(
      new Response(null, { status: 304, headers: { link: '<next>; rel="next"' } }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 304 }));
  const first = await fetchGitHubJsonPage(publicRepo, fetcher);
  const second = await fetchGitHubJsonPage(publicRepo, fetcher);
  const third = await fetchGitHubJsonPage(publicRepo, fetcher);
  expect(second.value).toBe(first.value);
  expect(second.link).toBe('<next>; rel="next"');
  expect(third.link).toBe(second.link);
});
