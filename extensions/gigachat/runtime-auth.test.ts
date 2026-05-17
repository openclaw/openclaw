import type { ProviderPrepareRuntimeAuthContext } from "openclaw/plugin-sdk/core";
import type { fetchWithTimeoutGuarded } from "openclaw/plugin-sdk/provider-http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const providerHttpMocks = vi.hoisted(() => ({
  fetchWithTimeoutGuarded: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>();
  return {
    ...actual,
    fetchWithTimeoutGuarded: providerHttpMocks.fetchWithTimeoutGuarded,
  };
});

type FetchWithTimeoutGuarded = typeof fetchWithTimeoutGuarded;
type FetchWithTimeoutGuardedCall = Parameters<FetchWithTimeoutGuarded>;

function mockTokenResponse(payload: Record<string, unknown>, status = 200) {
  const release = vi.fn(async () => {});
  providerHttpMocks.fetchWithTimeoutGuarded.mockResolvedValueOnce({
    response: new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    }),
    release,
  });
  return { release };
}

function buildRuntimeAuthContext(
  overrides: Partial<ProviderPrepareRuntimeAuthContext> = {},
): ProviderPrepareRuntimeAuthContext {
  return {
    env: {},
    provider: "gigachat",
    modelId: "GigaChat-2",
    model: {
      id: "GigaChat-2",
      name: "GigaChat 2",
      provider: "gigachat",
      api: "openai-completions",
      baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    } as never,
    apiKey: "encoded-client-secret",
    authMode: "api_key",
    ...overrides,
  };
}

function lastFetchCall(): FetchWithTimeoutGuardedCall {
  const call = providerHttpMocks.fetchWithTimeoutGuarded.mock.calls.at(-1);
  if (!call) {
    throw new Error("expected fetchWithTimeoutGuarded call");
  }
  return call as FetchWithTimeoutGuardedCall;
}

describe("GigaChat runtime auth", () => {
  beforeEach(async () => {
    providerHttpMocks.fetchWithTimeoutGuarded.mockReset();
    const { resetGigachatRuntimeAuthCacheForTest } = await import("./runtime-auth.js");
    resetGigachatRuntimeAuthCacheForTest();
  });

  it("exchanges the Authorization key for a scoped access token", async () => {
    const { prepareGigachatRuntimeAuth } = await import("./runtime-auth.js");
    const { release } = mockTokenResponse({
      access_token: "runtime-token",
      expires_at: 1_800,
    });

    const result = await prepareGigachatRuntimeAuth(
      buildRuntimeAuthContext({
        apiKey: "Basic encoded-client-secret",
        config: {
          plugins: {
            entries: {
              gigachat: {
                config: {
                  scope: "GIGACHAT_API_B2B",
                },
              },
            },
          },
        } as never,
      }),
      { now: () => 0, requestId: () => "00000000-0000-4000-8000-000000000001" },
    );

    expect(result).toEqual({
      apiKey: "runtime-token",
      expiresAt: 1_800_000,
    });
    const [url, init, timeoutMs] = lastFetchCall();
    expect(url).toBe("https://ngw.devices.sberbank.ru:9443/api/v2/oauth");
    expect(timeoutMs).toBe(60_000);
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Basic encoded-client-secret");
    expect(headers.get("RqUID")).toBe("00000000-0000-4000-8000-000000000001");
    expect(headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
    expect(String(init.body)).toBe("scope=GIGACHAT_API_B2B");
    expect(release).toHaveBeenCalledOnce();
  });

  it("applies configured TLS and private-network policy to the OAuth exchange", async () => {
    const { prepareGigachatRuntimeAuth } = await import("./runtime-auth.js");
    mockTokenResponse({
      access_token: "runtime-token",
      expires_at: 1_800,
    });

    await prepareGigachatRuntimeAuth(
      buildRuntimeAuthContext({
        config: {
          models: {
            providers: {
              gigachat: {
                baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
                models: [],
                request: {
                  headers: {
                    Authorization: "ignored",
                    RqUID: "ignored",
                    "X-Custom-Gigachat-Header": "kept",
                  },
                  tls: {
                    ca: "TEST CA",
                    serverName: "ngw.devices.sberbank.ru",
                  },
                  allowPrivateNetwork: true,
                },
              },
            },
          },
        } as never,
      }),
      { now: () => 0, requestId: () => "00000000-0000-4000-8000-000000000002" },
    );

    const [, init, , , options] = lastFetchCall();
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Basic encoded-client-secret");
    expect(headers.get("RqUID")).toBe("00000000-0000-4000-8000-000000000002");
    expect(headers.get("X-Custom-Gigachat-Header")).toBe("kept");
    expect(options?.ssrfPolicy).toEqual({ allowPrivateNetwork: true });
    expect(options?.dispatcherPolicy).toEqual({
      mode: "direct",
      connect: {
        ca: "TEST CA",
        servername: "ngw.devices.sberbank.ru",
      },
    });
  });

  it("reuses a cached access token until it is close to expiry", async () => {
    const { prepareGigachatRuntimeAuth } = await import("./runtime-auth.js");
    mockTokenResponse({
      access_token: "cached-token",
      expires_at: 1_800,
    });
    const ctx = buildRuntimeAuthContext();

    await prepareGigachatRuntimeAuth(ctx, { now: () => 0, requestId: () => "first" });
    const second = await prepareGigachatRuntimeAuth(ctx, {
      now: () => 60_000,
      requestId: () => "second",
    });

    expect(second.apiKey).toBe("cached-token");
    expect(providerHttpMocks.fetchWithTimeoutGuarded).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent token refreshes", async () => {
    const { prepareGigachatRuntimeAuth } = await import("./runtime-auth.js");
    let resolveResponse!: (value: unknown) => void;
    const responsePromise = new Promise((resolve) => {
      resolveResponse = resolve;
    });
    providerHttpMocks.fetchWithTimeoutGuarded.mockReturnValueOnce(responsePromise);
    const ctx = buildRuntimeAuthContext();

    const first = prepareGigachatRuntimeAuth(ctx, {
      now: () => 0,
      requestId: () => "first",
    });
    const second = prepareGigachatRuntimeAuth(ctx, {
      now: () => 0,
      requestId: () => "second",
    });

    expect(providerHttpMocks.fetchWithTimeoutGuarded).toHaveBeenCalledTimes(1);
    resolveResponse({
      response: new Response(JSON.stringify({ access_token: "deduped-token", expires_at: 1_800 })),
      release: vi.fn(async () => {}),
    });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { apiKey: "deduped-token", expiresAt: 1_800_000 },
      { apiKey: "deduped-token", expiresAt: 1_800_000 },
    ]);
  });

  it("surfaces token endpoint errors with provider detail", async () => {
    const { prepareGigachatRuntimeAuth } = await import("./runtime-auth.js");
    mockTokenResponse({ code: 7, message: "scope from db not fully includes consumed scope" }, 400);

    await expect(
      prepareGigachatRuntimeAuth(buildRuntimeAuthContext(), {
        now: () => 0,
        requestId: () => "bad-scope",
      }),
    ).rejects.toThrow(/scope from db not fully includes consumed scope/);
  });
});
