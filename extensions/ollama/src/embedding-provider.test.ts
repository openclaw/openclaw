import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOllamaEmbeddingProvider } from "./embedding-provider.js";
import { ollamaMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

const { fetchConfiguredLocalOriginWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchConfiguredLocalOriginWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: vi.fn(),
  formatErrorMessage: coerceErrorMessage,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin: (baseUrl: string) => {
    const parsed = new URL(baseUrl);
    return { allowedOrigins: [parsed.origin] };
  },
}));

// Import-resolution gating for this private helper is covered in sdk-alias.test.ts.
vi.mock("openclaw/plugin-sdk/ssrf-runtime-internal", () => ({
  fetchConfiguredLocalOriginWithSsrFGuard: fetchConfiguredLocalOriginWithSsrFGuardMock,
}));

beforeEach(() => {
  fetchConfiguredLocalOriginWithSsrFGuardMock.mockReset();
});

afterEach(() => vi.unstubAllEnvs());

type EmbeddingProviderOptions = Parameters<typeof createOllamaEmbeddingProvider>[0];
type MemoryEmbeddingOptions = Parameters<typeof ollamaMemoryEmbeddingProviderAdapter.create>[0];
type AuthCase = [
  name: string,
  selected: (Record<string, unknown> & { baseUrl?: string }) | undefined,
  remote: NonNullable<EmbeddingProviderOptions["remote"]>,
  headers: Record<string, string> | RegExp,
  providerId?: string,
];

function createProviderConfig(
  provider: Record<string, unknown>,
  providerId = "ollama",
): OpenClawConfig {
  return { models: { providers: { [providerId]: provider } } } as unknown as OpenClawConfig;
}

const PRIVATE_HOST = "https://selected-private-host.invalid";
const REMOTE_HOST = "https://remote-embedding-host.invalid";
const SELECTED_KEY = "synthetic-selected-host-key";
const REMOTE_KEY = "synthetic-remote-key";
const LOCAL_HOST = "http://127.0.0.1:11434";
const selectedKeyRef = envRef("OLLAMA_SELECTED_HOST_KEY");
const missingRef = envRef("OLLAMA_MISSING_SELECTED_SECRET");
const selectedProxyRef = envRef("OLLAMA_SELECTED_PROXY_KEY");
const selectedAuth = { Authorization: `Bearer ${SELECTED_KEY}` };
const remoteAuth = { Authorization: `Bearer ${REMOTE_KEY}` };
const selectedCredential = { apiKey: selectedKeyRef };
const missingCredential = { apiKey: missingRef };
const localCredential = { baseUrl: LOCAL_HOST, apiKey: "provider-host-key" };
const explicitAuth = { authorization: "Bearer synthetic-explicit-tenant-a" };
const proxyHeader = { "x-proxy-auth": "synthetic-remote-header" };
const remoteHeader = { "X-Remote-Auth": "synthetic-remote-header" };
const selectedWithProxy = { ...selectedCredential, headers: { "X-Proxy-Auth": selectedProxyRef } };
const selectedProxyAuth = { "X-Proxy-Auth": "synthetic-selected-proxy-key", ...selectedAuth };
const markerAuth = { Authorization: "Bearer ollama-local" };
const explicitRemote = { baseUrl: PRIVATE_HOST, headers: explicitAuth };
const overriddenProxy = { ...selectedCredential, headers: { "X-Proxy-Auth": missingRef } };
const remoteWithKey = { baseUrl: REMOTE_HOST, apiKey: REMOTE_KEY };
const cloudRemote = { baseUrl: "https://ollama.com" };
const cloudAuth = { Authorization: "Bearer synthetic-cloud-key" };
const execRef = { source: "exec", provider: "default", id: "synthetic-missing-ollama-secret" };
const execHeader = { ...selectedCredential, headers: { "X-Proxy-Auth": execRef } };
const keyError = /models\.providers\["ollama-private"\]\.apiKey/;
const headerError = /models\.providers\["ollama-private"\]\.headers\["X-Proxy-Auth"\]/;
const localMarker = {
  baseUrl: `${LOCAL_HOST}/v1`,
  apiKey: "ollama-\nlocal\r\n",
  headers: { "X-Provider-Header": "provider" },
};
const markerRef = { apiKey: envRef("OLLAMA_RESOLVED_MARKER") };

function stubCredentials() {
  vi.stubEnv("OLLAMA_API_KEY", "synthetic-cloud-key");
  vi.stubEnv("OLLAMA_SELECTED_HOST_KEY", SELECTED_KEY);
  vi.stubEnv("OLLAMA_SELECTED_PROXY_KEY", "synthetic-selected-proxy-key");
  vi.stubEnv("OLLAMA_MISSING_SELECTED_SECRET", "");
  vi.stubEnv("OLLAMA_RESOLVED_MARKER", "ollama-local");
}
function selectedConfig(provider: Record<string, unknown> = {}, providerId = "ollama") {
  return createProviderConfig(
    { baseUrl: `${PRIVATE_HOST}/v1`, models: [], ...provider },
    providerId,
  );
}

function embeddingOptions<T extends EmbeddingProviderOptions | MemoryEmbeddingOptions>(
  overrides: Partial<T> = {},
): T {
  return {
    config: {} as OpenClawConfig,
    provider: "ollama",
    model: "nomic-embed-text",
    fallback: "none",
    ...(overrides.config ? {} : { remote: { baseUrl: LOCAL_HOST } }),
    ...overrides,
  } as T;
}

function envRef(id: string) {
  return { source: "env", provider: "default", id } as const;
}

async function createEmbeddingProvider(overrides: Partial<EmbeddingProviderOptions> = {}) {
  return await createOllamaEmbeddingProvider(embeddingOptions(overrides));
}

async function memoryKey(overrides: Partial<MemoryEmbeddingOptions> = {}) {
  return (await ollamaMemoryEmbeddingProviderAdapter.create(embeddingOptions(overrides))).runtime
    ?.cacheKeyData;
}

function mockEmbeddingResponse(
  embeddings: unknown[] | Response = [[1, 0]],
  prompt_eval_count?: number,
) {
  return fetchConfiguredLocalOriginWithSsrFGuardMock.mockResolvedValue({
    response:
      embeddings instanceof Response
        ? embeddings
        : Response.json({ embeddings, prompt_eval_count }),
    release: async () => {},
  });
}

async function embedTestQuery(overrides: Partial<EmbeddingProviderOptions> = {}, query = "hello") {
  const fetchMock = mockEmbeddingResponse();
  const { provider } = await createEmbeddingProvider(overrides);
  expect(await provider.embed(query, { inputType: "query" })).toEqual([1, 0]);
  return { fetchMock, provider };
}

function expectEmbeddingFetch(
  url: string,
  headers: Record<string, string> = {},
  input: unknown = "search_query: hello",
  model = "nomic-embed-text",
) {
  const request = fetchConfiguredLocalOriginWithSsrFGuardMock.mock.calls[0]?.[0];
  expect([
    request?.url,
    request?.init?.method,
    request?.init?.headers,
    request?.init?.body,
  ]).toEqual([
    url,
    "POST",
    { "Content-Type": "application/json", ...headers },
    JSON.stringify({ model, input }),
  ]);
}

describe("ollama embedding provider", () => {
  it("preserves a host-applied query instruction instead of adding the family template", async () => {
    mockEmbeddingResponse();
    const { provider } = await createEmbeddingProvider();
    await provider.embed("custom: hello", { inputType: "query", queryInstructionApplied: true });
    expectEmbeddingFetch(`${LOCAL_HOST}/api/embed`, {}, "custom: hello");
  });

  it.each([7, -1])("sends one batch and reports native usage %s", async (tokens) => {
    const fetchMock = mockEmbeddingResponse(
      Array.from({ length: 3 }, () => [1, 0]),
      tokens,
    );
    const { provider } = await createEmbeddingProvider();
    const onUsage = vi.fn();
    await expect(provider.embedBatch(["a", "bb", "ccc"], { onUsage })).resolves.toHaveLength(3);
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(
      tokens === 7 ? { promptTokens: tokens, totalTokens: tokens } : undefined,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectEmbeddingFetch(`${LOCAL_HOST}/api/embed`, {}, ["a", "bb", "ccc"]);
    expect(fetchMock.mock.calls[0]?.[0]).toMatchObject({
      policy: { allowedOrigins: [LOCAL_HOST] },
      configuredLocalOriginBaseUrl: LOCAL_HOST,
    });
  });

  it("reports actionable embed errors for a missing model", async () => {
    const body = JSON.stringify({ error: 'model "all-minilm" not found, try pulling it first' });
    mockEmbeddingResponse(new Response(body, { status: 404 }));
    const { provider } = await createEmbeddingProvider({ model: "all-minilm" });
    await expect(provider.embed("hello", { inputType: "query" })).rejects.toMatchObject({
      message: `Ollama embed HTTP 404: ${body} Run \`ollama pull all-minilm\` on the configured Ollama host.`,
    });
  });

  it.each([
    [["0.1", 0.2], "a non-number embedding value"],
    [[], "an empty embedding"],
  ] as const)("rejects malformed embedding %j", async (embedding, error) => {
    mockEmbeddingResponse([embedding]);
    const { provider } = await createEmbeddingProvider();
    await expect(provider.embed("hello", { inputType: "query" })).rejects.toThrow(
      `Ollama embed response contains ${error}`,
    );
  });

  it.each([false, true])(
    "leases custom Ollama only without a remote override=%s",
    async (override) => {
      const release = vi.fn();
      const acquireLocalService = vi.fn(async (_target: unknown) => ({ release }));
      const service = { command: "/usr/bin/ollama-spark", args: ["serve"], idleStopMs: 10 };
      const headers = {
        "Content-Type": "application/json",
        "X-Custom-Ollama": "spark",
        Authorization: "Bearer spark-key",
      };
      const { provider } = await embedTestQuery({
        config: createProviderConfig(
          {
            baseUrl: "http://spark.local:11434/v1",
            apiKey: "spark-key",
            headers: { "X-Custom-Ollama": "spark" },
            localService: service,
            models: [],
          },
          "ollama-spark",
        ),
        provider: "ollama-spark",
        model: "ollama-spark/qwen3-embedding:4b",
        acquireLocalService,
        ...(override ? { remote: { baseUrl: "http://memory.local:11434" } } : {}),
      });

      expect(provider.model).toBe("qwen3-embedding:4b");
      expectEmbeddingFetch(
        `http://${override ? "memory" : "spark"}.local:11434/api/embed`,
        override ? {} : headers,
        "Instruct: Given a user query, retrieve relevant memory notes and documents\nQuery:hello",
        "qwen3-embedding:4b",
      );
      if (override) {
        expect(acquireLocalService).not.toHaveBeenCalled();
      } else {
        expect(acquireLocalService).toHaveBeenCalledWith(
          {
            providerId: "ollama-spark",
            baseUrl: "http://spark.local:11434/v1",
            headers,
          },
          undefined,
        );
        expect(release).toHaveBeenCalledOnce();
      }
    },
  );

  it.each<AuthCase>([
    ["ambient auth stays off local hosts", undefined, { baseUrl: LOCAL_HOST }, {}],
    ["ambient auth reaches cloud", undefined, cloudRemote, cloudAuth],
    [
      "remote SecretRef fails closed",
      undefined,
      { baseUrl: LOCAL_HOST, apiKey: envRef("OLLAMA_API_KEY") },
      /memory\.search\.remote\.apiKey: unresolved SecretRef/i,
    ],
    ["selected key fails closed", missingCredential, {}, keyError, "ollama-private"],
    ["selected header fails closed", execHeader, {}, headerError, "ollama-private"],
    ["local markers preserve headers", localMarker, {}, { "X-Provider-Header": "provider" }],
    ["refs override ambient auth", selectedWithProxy, {}, selectedProxyAuth, "ollama-private"],
    ["resolved markers stay opaque", markerRef, {}, markerAuth],
    ["explicit auth bypasses refs", missingCredential, explicitRemote, { ...explicitAuth }],
    [
      "remote headers override refs ignoring case",
      overriddenProxy,
      { baseUrl: PRIVATE_HOST, headers: proxyHeader },
      { ...proxyHeader, ...selectedAuth },
    ],
    [
      "host override drops literal key",
      localCredential,
      { baseUrl: "https://memory.example.com" },
      {},
    ],
    [
      "host override drops credential/header refs",
      { ...selectedCredential, headers: { "X-Selected-Host-Auth": selectedProxyRef } },
      { ...remoteWithKey, headers: remoteHeader },
      { ...remoteHeader, ...remoteAuth },
    ],
    ["remote auth bypasses host refs", missingCredential, remoteWithKey, remoteAuth],
    ["remote marker opts out", localCredential, { apiKey: "ollama-local" }, {}],
  ])("%s", async (_name, selected, remote, headers, providerId = "ollama") => {
    stubCredentials();
    const options = {
      config: selected ? selectedConfig(selected, providerId) : {},
      provider: providerId,
      remote,
      model: "",
    };
    if (headers instanceof RegExp) {
      const fetchMock = mockEmbeddingResponse();
      await expect(createEmbeddingProvider(options)).rejects.toThrow(headers);
      expect(fetchMock).not.toHaveBeenCalled();
      return;
    }
    await embedTestQuery(options);
    expectEmbeddingFetch(
      `${remote.baseUrl ?? selected?.baseUrl?.replace(/\/v1$/, "") ?? PRIVATE_HOST}/api/embed`,
      headers,
    );
  });

  it("preserves the legacy identity only for the default Ollama endpoint", async () => {
    const defaultEndpoint = await memoryKey({ dimensions: 2 });
    const customEndpoint = await memoryKey({
      remote: { baseUrl: "http://10.0.0.5:11434" },
      dimensions: 2,
    });
    const identity = {
      provider: "ollama",
      model: "nomic-embed-text",
      outputDimensionality: 2,
    };
    expect(defaultEndpoint).toEqual(identity);
    expect(customEndpoint).toEqual({
      ...identity,
      baseUrl: "http://10.0.0.5:11434",
    });
  });

  // Vary the credential and the non-secret tenant header independently: only
  // the tenant may change the cache key.
  it("keys custom endpoints by non-secret headers while excluding credentials", async () => {
    const createCustomProvider = (tenant: string, apiKey: string) =>
      memoryKey({
        config: createProviderConfig(
          {
            api: "ollama",
            baseUrl: "https://ollama-cpu.home.lab",
            headers: { "X-Ollama-Tenant": tenant, "X-Api-Key": apiKey },
            models: [],
          },
          "ollama-cpu",
        ),
        provider: "ollama-cpu",
        model: "qwen3-embedding:4b",
      });
    const result = await createCustomProvider("tenant-a", "super-secret"); // pragma: allowlist secret

    expect(result).toMatchObject({
      provider: "ollama-cpu",
      baseUrl: "https://ollama-cpu.home.lab",
      model: "qwen3-embedding:4b",
      headersHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(result)).not.toContain("tenant-a");
    expect(JSON.stringify(result)).not.toContain("super-secret");
    const rotatedCredential = await createCustomProvider("tenant-a", "rotated-fixture-key");
    expect(rotatedCredential).toEqual(result);
    const otherTenant = await createCustomProvider("tenant-b", "super-secret"); // pragma: allowlist secret
    expect(otherTenant).not.toEqual(result);
  });
});
