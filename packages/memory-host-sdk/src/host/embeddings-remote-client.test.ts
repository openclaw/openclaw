// Memory Host SDK tests cover embeddings remote client behavior.
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

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  it.each<{
    allow: boolean | undefined;
    path: string;
    permitted: boolean;
    hits: string[];
    remoteOverride?: boolean;
  }>([
    { allow: undefined, path: "/v1", permitted: true, hits: ["/v1/embeddings"] },
    { allow: false, path: "/v1", permitted: false, hits: [] },
    { allow: undefined, path: "/redirect", permitted: false, hits: ["/redirect/embeddings"] },
    {
      allow: true,
      path: "/redirect",
      permitted: true,
      hits: ["/redirect/embeddings", "redirect-target"],
    },
    {
      allow: undefined,
      path: "/v1",
      permitted: true,
      hits: ["/v1/embeddings"],
      remoteOverride: true,
    },
    { allow: false, path: "/v1", permitted: false, hits: [], remoteOverride: true },
  ])(
    "uses inference policy for allow=$allow and $path",
    async ({ allow, path, permitted, hits, remoteOverride }) => {
      const client = await resolveRemoteEmbeddingBearerClient({
        provider: "fixture",
        defaultBaseUrl: "https://api.openai.com/v1",
        options: {
          config: {
            models: {
              providers: {
                fixture: {
                  api: "openai-completions",
                  baseUrl: remoteOverride
                    ? "https://provider.example.test/v1"
                    : `${baseUrl}${path}`,
                  apiKey: "fixture-key",
                  request: { allowPrivateNetwork: allow },
                  models: [],
                },
              },
            },
          },
          model: "fixture-model",
          ...(remoteOverride
            ? { remote: { baseUrl: `${baseUrl}${path}`, apiKey: "remote-fixture-key" } }
            : {}),
        },
      });
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
    const client = await resolveRemoteEmbeddingBearerClient({
      provider: "openai",
      defaultBaseUrl: "https://api.openai.com/v1",
      options: {
        config: {
          models: {
            providers: {
              openai: {
                baseUrl,
                request: { allowPrivateNetwork: allow },
                models: [],
              },
            },
          },
        },
        model: "fixture-model",
        remote: { apiKey: "fixture-key" },
      },
    });
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
  it.each<{
    name: string;
    remote: NonNullable<EmbeddingProviderOptions["remote"]>;
    authorization: string;
    tenant: string;
  }>([
    {
      name: "uses only destination-owned remote credentials",
      remote: {
        baseUrl: "https://remote.example.test/v1",
        apiKey: "remote-key",
        headers: { "X-Remote-Tenant": "remote-b" },
      },
      authorization: "Bearer remote-key",
      tenant: "remote-b",
    },
    {
      name: "accepts a destination-owned Authorization header without an API key",
      remote: {
        baseUrl: "https://remote.example.test/v1",
        headers: { Authorization: "Bearer remote-header-key", "X-Remote-Tenant": "remote-b" },
      },
      authorization: "Bearer remote-header-key",
      tenant: "remote-b",
    },
  ])("$name", async ({ remote, authorization, tenant }) => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const client = await resolveRemoteEmbeddingBearerClient({
      provider: "openai",
      defaultBaseUrl: "https://api.openai.com/v1",
      options: {
        config: { models: { providers: { openai: configuredProvider } } } as never,
        model: "text-embedding-3-small",
        remote,
      },
    });

    expect(client.baseUrl).toBe(remote.baseUrl);
    expect(client.headers.Authorization).toBe(authorization);
    expect(client.headers["X-Remote-Tenant"]).toBe(tenant);
    expect(client.headers).not.toHaveProperty("X-Provider-Tenant");
  });

  it("fails before egress when a remote destination has no destination-owned auth", async () => {
    await expect(
      resolveRemoteEmbeddingBearerClient({
        provider: "openai",
        defaultBaseUrl: "https://api.openai.com/v1",
        options: {
          config: { models: { providers: { openai: configuredProvider } } } as never,
          model: "text-embedding-3-small",
          remote: { baseUrl: "https://remote.example.test/v1" },
        },
      }),
    ).rejects.toThrow(/memory\.search\.remote\.apiKey|Authorization header/);
  });

  it("lets the last source replace mixed-case auth, tenant, and default headers", async () => {
    const client = await resolveRemoteEmbeddingBearerClient({
      provider: "openai",
      defaultBaseUrl: configuredProvider.baseUrl,
      options: {
        config: {
          models: {
            providers: {
              openai: {
                ...configuredProvider,
                headers: {
                  Authorization: "first",
                  authorization: "second",
                  "X-Tenant": "first",
                  "x-tenant": "second",
                },
              },
            },
          },
        },
        model: "fixture-embedding",
        remote: {
          headers: {
            Authorization: "Bearer remote",
            "X-Tenant": "remote",
            "content-type": "application/json; charset=utf-8",
            "X-Unchanged": "value",
          },
        },
      },
    });

    expect(client.headers).toEqual({
      "content-type": "application/json; charset=utf-8",
      Authorization: "Bearer remote",
      "X-Tenant": "remote",
      "X-Unchanged": "value",
    });
  });

  it("treats loopback address families as distinct credential destinations", async () => {
    await expect(
      resolveRemoteEmbeddingBearerClient({
        provider: "openai",
        defaultBaseUrl: "http://localhost:12345/v1",
        options: {
          config: {
            models: {
              providers: {
                openai: { ...configuredProvider, baseUrl: "http://localhost:12345/v1" },
              },
            },
          } as never,
          model: "text-embedding-3-small",
          remote: { baseUrl: "http://127.0.0.1:12345/v1" },
        },
      }),
    ).rejects.toThrow(/memory\.search\.remote\.apiKey|Authorization header/);
  });

  it("treats query-distinct URLs as different credential destinations", async () => {
    await expect(
      resolveRemoteEmbeddingBearerClient({
        provider: "openai",
        defaultBaseUrl: "https://provider.example.test/v1?tenant=provider",
        options: {
          config: {
            models: {
              providers: {
                openai: {
                  ...configuredProvider,
                  baseUrl: "https://provider.example.test/v1?tenant=provider",
                },
              },
            },
          } as never,
          model: "text-embedding-3-small",
          remote: { baseUrl: "https://provider.example.test/v1?tenant=remote" },
        },
      }),
    ).rejects.toThrow(/memory\.search\.remote\.apiKey|Authorization header/);
  });

  it("does not inherit a chat-only subscription base URL for embeddings", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENCLAW_VERSION", "2026.3.22");
    const client = await resolveRemoteEmbeddingBearerClient({
      provider: "openai",
      defaultBaseUrl: "https://api.openai.com/v1",
      options: {
        config: {
          models: {
            providers: {
              openai: {
                ...configuredProvider,
                api: "openai-chatgpt-responses",
                baseUrl: "https://chatgpt.com/backend-api/codex",
              },
            },
          },
        } as never,
        model: "text-embedding-3-small",
        remote: { headers: { Originator: "caller", "user-agent": "caller" } },
      },
    });

    // The Codex chat route cannot serve embeddings; the adapter default wins.
    expect(client.baseUrl).toBe("https://api.openai.com/v1");
    // Destination now matches the provider's effective destination, so the
    // provider's own credentials still resolve — just at the embedding route.
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
    const client = await resolveRemoteEmbeddingBearerClient({
      provider: "openai",
      defaultBaseUrl: "https://api.openai.com/v1",
      options: {
        config: {
          models: {
            providers: {
              openai: {
                ...configuredProvider,
                api: "openai-chatgpt-responses",
                baseUrl: "https://provider.example.test/v1",
              },
            },
          },
        } as never,
        model: "text-embedding-3-small",
      },
    });

    // The custom destination keeps ownership: no redirect to the adapter
    // default, so the provider's credentials never leave its own destination.
    expect(client.baseUrl).toBe("https://provider.example.test/v1");
    expect(client.headers.Authorization).toBe("Bearer provider-key");
    expect(client.headers["X-Provider-Tenant"]).toBe("provider-a");
    expect(client.headers).not.toHaveProperty("originator");
  });

  it("keeps the destination-owned credential guard when a subscription-mode provider uses a custom URL", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    await expect(
      resolveRemoteEmbeddingBearerClient({
        provider: "openai",
        defaultBaseUrl: "https://api.openai.com/v1",
        options: {
          config: {
            models: {
              providers: {
                openai: {
                  ...configuredProvider,
                  api: "openai-chatgpt-responses",
                  baseUrl: "https://provider.example.test/v1",
                  headers: {
                    Authorization: "Bearer custom-proxy-key",
                    "X-Provider-Tenant": "provider-a",
                  },
                },
              },
            },
          } as never,
          model: "text-embedding-3-small",
          remote: { baseUrl: "https://api.openai.com/v1" },
        },
      }),
    ).rejects.toThrow(/memory\.search\.remote\.apiKey|Authorization header/);
  });

  it("keeps the destination-owned credential guard on an explicit remote destination", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    await expect(
      resolveRemoteEmbeddingBearerClient({
        provider: "openai",
        defaultBaseUrl: "https://api.openai.com/v1",
        options: {
          config: {
            models: {
              providers: {
                openai: {
                  ...configuredProvider,
                  api: "openai-chatgpt-responses",
                  baseUrl: "https://chatgpt.com/backend-api/codex",
                },
              },
            },
          } as never,
          model: "text-embedding-3-small",
          remote: { baseUrl: "https://remote.example.test/v1" },
        },
      }),
    ).rejects.toThrow(/memory\.search\.remote\.apiKey|Authorization header/);
  });
});
