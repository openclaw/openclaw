import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { createServer } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard } from "../../../../src/infra/net/fetch-guard.js";
import { reserveTestPortListener } from "../../../../src/test-utils/port-claims.js";
import { resolveRemoteEmbeddingBearerClient } from "./embeddings-remote-client.js";
import { createRemoteEmbeddingProvider } from "./embeddings-remote-provider.js";
import type { EmbeddingProviderOptions } from "./embeddings.types.js";

// Unit tests run in worker threads, where shared auth state requires the Gateway host broker.
// An empty store keeps the real credential precedence and falls through to configured keys.
vi.mock("../../../../src/agents/auth-profiles/store-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../../src/agents/auth-profiles/store-runtime.js")
  >()),
  ensureAuthProfileStoreAsync: vi.fn(async () => ({ version: 1, profiles: {} })),
}));

const configuredProvider = {
  baseUrl: "https://provider.example.test/v1",
  apiKey: "provider-key",
  headers: { "X-Provider-Tenant": "provider-a" },
  models: [],
};

type ProviderConfig = NonNullable<
  NonNullable<EmbeddingProviderOptions["config"]["models"]>["providers"]
>[string];

function resolveClient(
  providerConfig: ProviderConfig,
  remote?: EmbeddingProviderOptions["remote"],
  defaultBaseUrl = "https://api.openai.com/v1",
  model = "text-embedding-3-small",
  provider = "openai",
) {
  return resolveRemoteEmbeddingBearerClient({
    provider,
    defaultBaseUrl,
    options: { config: { models: { providers: { [provider]: providerConfig } } }, model, remote },
  });
}

afterEach(() => vi.unstubAllEnvs());

describe("remote embedding private-network policy", () => {
  const requests: string[] = [];
  let baseUrl: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const target = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((_req, res) => {
          requests.push("redirect-target");
          res.end('{"data":[{"embedding":[1,2,3]}]}');
        }),
    });
    const source = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((req, res) => {
          requests.push(req.url ?? "");
          if (req.url === "/redirect/embeddings") {
            res.writeHead(307, {
              location: `http://127.0.0.1:${target.claim.port}/embeddings`,
            });
            res.end();
          } else {
            res.end('{"data":[{"embedding":[1,2,3]}]}');
          }
        }),
    });
    baseUrl = `http://127.0.0.1:${source.claim.port}`;
    cleanup = async () => {
      await source.releaseListener();
      await target.releaseListener();
      await source.claim.release();
      await target.claim.release();
    };
  });

  beforeEach(() => {
    requests.length = 0;
  });

  afterAll(async () => await cleanup());

  it.each<[boolean | undefined, string, boolean, string[], boolean?]>([
    [undefined, "/v1", true, ["/v1/embeddings"]],
    [false, "/v1", false, []],
    [undefined, "/redirect", false, ["/redirect/embeddings"]],
    [true, "/redirect", true, ["/redirect/embeddings", "redirect-target"]],
    [undefined, "/v1", true, ["/v1/embeddings"], true],
    [false, "/v1", false, [], true],
  ])(
    "uses inference policy for allow=%s and %s (case %#)",
    async (allow, path, permitted, hits, remoteOverride) => {
      const client = await resolveClient(
        {
          api: "openai-completions",
          baseUrl: remoteOverride ? "https://provider.example.test/v1" : `${baseUrl}${path}`,
          apiKey: "fixture-key",
          request: { allowPrivateNetwork: allow },
          models: [],
        },
        remoteOverride ? { baseUrl: `${baseUrl}${path}`, apiKey: "remote-fixture-key" } : undefined,
        "https://api.openai.com/v1",
        "fixture-model",
        "fixture",
      );
      const provider = createRemoteEmbeddingProvider({
        id: "fixture",
        client: { ...client, model: "fixture-model" },
        errorPrefix: "fixture embeddings",
      });
      if (permitted) {
        await expect(provider.embed("fixture")).resolves.toEqual([1, 2, 3]);
      } else {
        await expect(provider.embed("fixture")).rejects.toThrow(/private\/internal\/special-use/);
      }
      expect(requests).toEqual(hits);
    },
  );
});

it.each([
  { hostname: "probe.openai.azure.com", allow: undefined, permitted: false },
  { hostname: "probe.openai.azure.com", allow: true, permitted: true },
  { hostname: "llm.corp.example", allow: undefined, permitted: true },
])(
  "uses inference private-DNS policy for $hostname, allow=$allow",
  async ({ hostname, allow, permitted }) => {
    const baseUrl = `https://${hostname}/v1`;
    const client = await resolveClient(
      {
        baseUrl,
        request: { allowPrivateNetwork: allow },
        models: [],
      },
      { apiKey: "fixture-key" },
      "https://api.openai.com/v1",
      "fixture-model",
    );
    const fetchImpl = vi.fn(async () => new Response("fixture"));
    const result = fetchWithSsrFGuard({
      url: `${baseUrl}/embeddings`,
      policy: client.ssrfPolicy,
      fetchImpl,
      lookupFn: async () => [{ address: "10.0.0.5", family: 4 }],
    });
    if (permitted) {
      const response = await result;
      await response.release();
      expect(fetchImpl).toHaveBeenCalledOnce();
    } else {
      await expect(result).rejects.toThrow(/private\/internal\/special-use/);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  },
);

describe("resolveRemoteEmbeddingBearerClient", () => {
  it.each(["apiKey", "Authorization"])("uses destination-owned %s credentials", async (kind) => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const authorization = "Bearer remote-key";
    const remote = {
      baseUrl: "https://remote.example.test/v1",
      ...(kind === "apiKey" ? { apiKey: "remote-key" } : {}),
      headers: {
        "X-Remote-Tenant": "remote-b",
        ...(kind === "Authorization" ? { Authorization: authorization } : {}),
      },
    };
    const client = await resolveClient(configuredProvider, remote);

    expect(client).toMatchObject({
      baseUrl: remote.baseUrl,
      headers: { Authorization: authorization, "X-Remote-Tenant": "remote-b" },
    });
    expect(client.headers).not.toHaveProperty("X-Provider-Tenant");
  });

  it.each([
    ["ordinary provider", configuredProvider, "https://remote.example.test/v1"],
    [
      "custom subscription-mode provider",
      {
        ...configuredProvider,
        api: "openai-chatgpt-responses",
        headers: { Authorization: "Bearer custom-proxy-key", "X-Provider-Tenant": "provider-a" },
      },
      "https://api.openai.com/v1",
    ],
    [
      "native subscription provider",
      {
        ...configuredProvider,
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
      "https://remote.example.test/v1",
    ],
  ] as const)(
    "rejects foreign destinations without their own auth: %s",
    async (_, provider, baseUrl) => {
      vi.stubEnv("OPENAI_API_KEY", "");
      await expect(resolveClient(provider, { baseUrl })).rejects.toThrow(
        /memory\.search\.remote\.apiKey|Authorization header/,
      );
    },
  );

  it("lets the last source replace mixed-case auth, tenant, and default headers", async () => {
    const client = await resolveClient(
      {
        ...configuredProvider,
        headers: {
          Authorization: "first",
          authorization: "second",
          "X-Tenant": "first",
          "x-tenant": "second",
        },
      },
      {
        headers: {
          Authorization: "Bearer remote",
          "X-Tenant": "remote",
          "content-type": "application/json; charset=utf-8",
          "X-Unchanged": "value",
        },
      },
      configuredProvider.baseUrl,
      "fixture-embedding",
    );

    expect(client.headers).toEqual({
      "content-type": "application/json; charset=utf-8",
      Authorization: "Bearer remote",
      "X-Tenant": "remote",
      "X-Unchanged": "value",
    });
  });

  it.each([
    ["loopback address families", "http://localhost:12345/v1", "http://127.0.0.1:12345/v1"],
    [
      "query-distinct URLs",
      "https://provider.example.test/v1?tenant=provider",
      "https://provider.example.test/v1?tenant=remote",
    ],
  ])("treats %s as distinct credential destinations", async (_name, providerUrl, remoteUrl) => {
    await expect(
      resolveClient(
        { ...configuredProvider, baseUrl: providerUrl },
        { baseUrl: remoteUrl },
        providerUrl,
      ),
    ).rejects.toThrow(/memory\.search\.remote\.apiKey|Authorization header/);
  });

  it("does not inherit a chat-only subscription base URL for embeddings", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENCLAW_VERSION", "2026.3.22");
    const client = await resolveClient(
      {
        ...configuredProvider,
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
      { headers: { Originator: "caller", "user-agent": "caller" } },
    );

    expect(client.baseUrl).toBe("https://api.openai.com/v1");
    expect(client.headers).toEqual({
      Authorization: "Bearer provider-key",
      "Content-Type": "application/json",
      "X-Provider-Tenant": "provider-a",
      originator: "openclaw",
      version: "2026.3.22",
      "User-Agent": "openclaw/2026.3.22",
    });
  });

  it("does not redirect a custom provider URL for a chat-only subscription api mode", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const client = await resolveClient({
      ...configuredProvider,
      api: "openai-chatgpt-responses",
    });

    expect(client).toMatchObject({
      baseUrl: "https://provider.example.test/v1",
      headers: { Authorization: "Bearer provider-key", "X-Provider-Tenant": "provider-a" },
    });
    expect(client.headers).not.toHaveProperty("originator");
  });
});
