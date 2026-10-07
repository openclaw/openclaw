import type { LookupAddress } from "node:dns";
import type { DispatcherAwareRequestInit } from "openclaw/plugin-sdk/runtime-fetch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createXaiWebSearchProvider } from "./web-search.js";
import { createXSearchTool } from "./x-search.js";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: async () => ({ mode: "api-key", source: "test" }),
}));

type PinnedLookup = (
  hostname: string,
  options: { all: true },
  callback: (error: Error | null, addresses: LookupAddress[]) => void,
) => void;

class FixtureAgent {
  static instances: FixtureAgent[] = [];
  closed = false;
  constructor(
    readonly options: { connect?: { lookup?: PinnedLookup; rejectUnauthorized?: boolean } } = {},
  ) {
    FixtureAgent.instances.push(this);
  }
  async close() {
    this.closed = true;
  }
}

class FixtureEnvHttpProxyAgent extends FixtureAgent {}
class FixtureProxyAgent extends FixtureAgent {}

const privateAddress = { address: "172.30.250.131", family: 4 };
const publicAddress = { address: "2606:4700:4700::1111", family: 6 };
let requests: Array<{ url: string; addresses: LookupAddress[]; init?: RequestInit }>;
let responses: Response[];

function answer() {
  return Response.json({
    output_text: "OpenClaw search answer",
    citations: ["http://other-service:4000/"],
  });
}

beforeEach(() => {
  requests = [];
  responses = [];
  FixtureAgent.instances = [];
  lookup.mockReset().mockResolvedValue([privateAddress]);
  for (const name of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "OPENCLAW_PROXY_ACTIVE",
    "OPENCLAW_DEBUG_PROXY_ENABLED",
  ]) {
    vi.stubEnv(name, undefined);
  }
  // Do not use a Vitest global fetch mock: that transport intentionally skips DNS.
  vi.stubGlobal("fetch", async () => {
    throw new Error("Must use the pinned runtime transport");
  });
  vi.stubGlobal("__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__", {
    Agent: FixtureAgent,
    EnvHttpProxyAgent: FixtureEnvHttpProxyAgent,
    ProxyAgent: FixtureProxyAgent,
    fetch: async (input: string, init?: DispatcherAwareRequestInit) => {
      const dispatcher = init?.dispatcher;
      if (!(dispatcher instanceof FixtureAgent)) {
        throw new Error("Expected the guarded runtime dispatcher");
      }
      expect(dispatcher.constructor).toBe(FixtureAgent);
      const pinnedLookup = dispatcher.options.connect?.lookup;
      if (!pinnedLookup) {
        throw new Error("Expected pinned DNS");
      }
      expect(dispatcher.options.connect?.rejectUnauthorized).not.toBe(false);
      const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
        pinnedLookup(new URL(input).hostname, { all: true }, (error, values) => {
          if (error) {
            reject(error);
          } else {
            resolve(values);
          }
        });
      });
      requests.push({ url: input, addresses, init });
      return responses.shift() ?? answer();
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function search(
  kind: "webSearch" | "xSearch",
  settings: Record<string, unknown>,
  query: string,
  webSearch: Record<string, unknown> = {},
  cacheTtlMinutes = 0,
) {
  const config = {
    plugins: {
      entries: {
        xai: {
          config: {
            webSearch: {
              apiKey: "xai-network-test-key",
              ...webSearch,
              ...(kind === "webSearch" ? settings : {}),
            },
            ...(kind === "xSearch"
              ? { xSearch: { enabled: true, cacheTtlMinutes, ...settings } }
              : {}),
          },
        },
      },
    },
  };
  if (kind === "webSearch") {
    const tool = createXaiWebSearchProvider().createTool({
      config,
      searchConfig: { cacheTtlMinutes },
    });
    if (!tool) {
      throw new Error("Expected web_search");
    }
    return tool.execute({ query, count: 1 });
  }
  const tool = createXSearchTool({ config });
  if (!tool) {
    throw new Error("Expected x_search");
  }
  return tool.execute("network-policy-test", { query });
}

describe.each(["webSearch", "xSearch"] as const)("xAI %s network policy", (kind) => {
  it.each([undefined, "strict"])("blocks private DNS by default (%s)", async (networkPolicy) => {
    await expect(
      search(kind, { baseUrl: "http://litellm:4000/v1", networkPolicy }, "strict search"),
    ).rejects.toThrow(/private\/internal/);
    expect(requests).toEqual([]);
  });

  it("allows only the configured self-hosted origin with pinned mixed DNS answers", async () => {
    lookup.mockResolvedValue([privateAddress, publicAddress]);
    await search(
      kind,
      { baseUrl: "http://litellm:4000/v1", networkPolicy: "selfHosted" },
      "self hosted search",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "http://litellm:4000/v1/responses",
      addresses: [privateAddress],
    });
    const requestBody = requests[0]?.init?.body;
    if (typeof requestBody !== "string") {
      throw new Error("Expected a JSON string request body");
    }
    expect(JSON.parse(requestBody).tools).toEqual([
      { type: kind === "webSearch" ? "web_search" : "x_search" },
    ]);
    expect(lookup).toHaveBeenCalledOnce();
    expect(FixtureAgent.instances.every((agent) => agent.closed)).toBe(true);
  });

  it.each(["http://127.0.0.1:4000/v1", "http://localhost:4000/v1", "http://[::1]:4000/v1"])(
    "allows an explicitly configured loopback endpoint: %s",
    async (baseUrl) => {
      lookup.mockResolvedValue([
        {
          address: baseUrl.includes("[::1]") ? "::1" : "127.0.0.1",
          family: baseUrl.includes("[::1]") ? 6 : 4,
        },
      ]);
      await search(kind, { baseUrl, networkPolicy: "selfHosted" }, "explicit loopback search");
      expect(requests).toHaveLength(1);
    },
  );

  it("does not let environment or managed proxies replace pinned DNS", async () => {
    vi.stubEnv("HTTP_PROXY", "http://proxy.example:8080");
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example:8080");
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
    await search(
      kind,
      { baseUrl: "https://litellm:4000/v1", networkPolicy: "selfHosted" },
      "pinned proxy search",
    );
    expect(requests[0]?.addresses).toEqual([privateAddress]);
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("requires an explicit base URL for self-hosted trust", async () => {
    await expect(
      search(kind, { networkPolicy: "selfHosted" }, "missing endpoint search"),
    ).rejects.toThrow(/requires an explicit baseUrl/);
    expect(requests).toEqual([]);
  });

  it("does not reuse self-hosted cached answers after returning to strict policy", async () => {
    const baseUrl = "http://litellm:4000/v1";
    const query = `${kind} cache policy boundary`;
    await search(kind, { baseUrl, networkPolicy: "selfHosted" }, query, {}, 15);
    await expect(search(kind, { baseUrl }, query, {}, 15)).rejects.toThrow(/private\/internal/);
    expect(requests).toHaveLength(1);
  });

  it.each(["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/"])(
    "keeps official-provider redirects to private targets blocked: %s",
    async (location) => {
      lookup.mockResolvedValue([publicAddress]);
      responses.push(new Response(null, { status: 302, headers: { location } }));
      await expect(search(kind, {}, "official redirect search")).rejects.toThrow(/Blocked/);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://api.x.ai/v1/responses");
    },
  );

  it.each([
    "http://litellm:4001/v1/responses",
    "http://other-service:4000/v1/responses",
    "http://127.0.0.1:4000/",
    "http://169.254.169.254/latest/meta-data/",
    "https://litellm:4000/v1/responses",
  ])("blocks redirects outside the configured origin: %s", async (location) => {
    responses.push(new Response(null, { status: 302, headers: { location } }));
    await expect(
      search(
        kind,
        { baseUrl: "http://litellm:4000/v1", networkPolicy: "selfHosted" },
        "redirect search",
      ),
    ).rejects.toThrow(/Blocked/);
    expect(requests).toHaveLength(1);
    expect(lookup).toHaveBeenCalledOnce();
    expect(FixtureAgent.instances.every((agent) => agent.closed)).toBe(true);
  });

  it("revalidates and pins DNS on same-origin redirects", async () => {
    lookup
      .mockResolvedValueOnce([privateAddress])
      .mockResolvedValueOnce([privateAddress, publicAddress]);
    responses.push(new Response(null, { status: 307, headers: { location: "/v2/responses" } }));
    await search(
      kind,
      { baseUrl: "http://litellm:4000/v1", networkPolicy: "selfHosted" },
      "same origin search",
    );
    expect(requests.map((request) => request.url)).toEqual([
      "http://litellm:4000/v1/responses",
      "http://litellm:4000/v2/responses",
    ]);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it.each(["127.0.0.1", "169.254.169.254"])(
    "rejects a configured hostname rebinding to %s",
    async (address) => {
      lookup
        .mockResolvedValueOnce([privateAddress])
        .mockResolvedValueOnce([{ address, family: 4 }]);
      responses.push(new Response(null, { status: 307, headers: { location: "/v2/responses" } }));
      await expect(
        search(
          kind,
          { baseUrl: "http://litellm:4000/v1", networkPolicy: "selfHosted" },
          "rebind search",
        ),
      ).rejects.toThrow(/private\/internal/);
      expect(requests).toHaveLength(1);
      expect(lookup).toHaveBeenCalledTimes(2);
    },
  );
});

it("inherits the webSearch base URL but not its network policy for x_search", async () => {
  const webSearch = { baseUrl: "http://litellm:4000/v1", networkPolicy: "selfHosted" };
  await expect(search("xSearch", {}, "fallback strict search", webSearch)).rejects.toThrow(
    /private\/internal/,
  );
  await search("xSearch", { networkPolicy: "selfHosted" }, "fallback opt-in search", webSearch);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe("http://litellm:4000/v1/responses");
});
