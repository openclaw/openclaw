import type {
  ProviderCatalogContext,
  ProviderPrepareDynamicModelContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { successfulDiscovery } from "./external-server.test-support.js";
import { discoverLlamaServerProvider, prepareLlamaServerDynamicModel } from "./provider.js";

const discoverMock = vi.hoisted(() => vi.fn());
const runtimeApiKeyMock = vi.hoisted(() => vi.fn());
vi.mock("./discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./discovery.js")>()),
  discoverLlamaServer: discoverMock,
}));
vi.mock("./auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.js")>()),
  resolveLlamaServerRuntimeApiKey: runtimeApiKeyMock,
}));

const LOCAL_BASE_URL = "http://localhost:8080/v1";
const DISCOVERY_ORIGIN = "http://127.0.0.1:8080";
const DISCOVERY_BASE_URL = "http://127.0.0.1:8080/v1";

function success(name = "org/model:Q4") {
  return successfulDiscovery(DISCOVERY_ORIGIN, { id: "org/model:Q4", name });
}

function catalogContext(provider?: Partial<ModelProviderConfig>): ProviderCatalogContext {
  const config: ProviderCatalogContext["config"] = {};
  if (provider) {
    const configured = { baseUrl: LOCAL_BASE_URL, models: [], ...provider };
    config.models = { providers: { "llama-cpp": configured } };
  }
  return {
    config,
    env: {},
    resolveProviderApiKey: vi.fn(() => ({ apiKey: undefined })),
    resolveProviderAuth: vi.fn(
      () => ({ apiKey: undefined, mode: "none", source: "none" }) as const,
    ),
  };
}

function expectDiscovery(params: Record<string, unknown>) {
  expect(discoverMock).toHaveBeenCalledWith(expect.objectContaining(params));
}

function dynamicContext(
  overrides: Partial<ProviderPrepareDynamicModelContext> = {},
): ProviderPrepareDynamicModelContext {
  return {
    config: {},
    provider: "llama-cpp",
    modelId: "org/model:Q4",
    modelRegistry: {} as never,
    providerConfig: {
      baseUrl: LOCAL_BASE_URL,
      api: "openai-completions",
    },
    ...overrides,
  };
}

describe("llama-server provider discovery", () => {
  beforeEach(() => {
    discoverMock.mockReset();
    runtimeApiKeyMock.mockReset().mockResolvedValue(undefined);
  });

  it("publishes live discovery with the profile that supplied its credential", async () => {
    discoverMock.mockResolvedValue(success());
    const ctx = catalogContext();
    ctx.resolveProviderApiKey = () => ({
      apiKey: "LLAMA_SERVER_API_KEY",
      discoveryApiKey: "profile-key",
      profileId: "llama-cpp:default",
    });

    await expect(discoverLlamaServerProvider(ctx)).resolves.toMatchObject({
      provider: {
        baseUrl: DISCOVERY_BASE_URL,
        api: "openai-completions",
        models: [expect.objectContaining({ id: "org/model:Q4" })],
      },
      outcomes: [{ provider: "llama-cpp", profileId: "llama-cpp:default", status: "ready" }],
    });
    expectDiscovery({ apiKey: "profile-key" });
  });

  it("prefers configured Authorization over ambient API-key discovery auth", async () => {
    discoverMock.mockResolvedValue(success());
    const headers = { Authorization: "Bearer proxy-key" };
    const ctx = catalogContext({ headers });
    ctx.resolveProviderApiKey = vi.fn(() => ({
      apiKey: "LLAMA_SERVER_API_KEY",
      discoveryApiKey: "ambient-key",
      profileId: "llama-cpp:ambient",
    }));

    const result = await discoverLlamaServerProvider(ctx);
    expect(result?.outcomes).toEqual([{ provider: "llama-cpp", status: "ready" }]);

    expectDiscovery({ apiKey: undefined, headers });
  });

  it.each([
    { failure: { kind: "http-error", status: 401 }, status: "auth-rejected" },
    { failure: { kind: "http-error", status: 503 }, status: "unavailable" },
    { failure: { kind: "unreachable", error: new Error("offline") }, status: "unavailable" },
  ])(
    "reports $failure as $status instead of publishing empty discovery",
    async ({ failure, status }) => {
      discoverMock.mockResolvedValue({ ...failure, endpoint: success().endpoint });
      const ctx = catalogContext({ models: success().models.map((model) => model.config) });

      await expect(discoverLlamaServerProvider(ctx)).resolves.toEqual({
        providers: {},
        outcomes: [
          {
            provider: "llama-cpp",
            status,
            ...(status === "auth-rejected" ? { rejectionScope: "catalog" } : {}),
          },
        ],
      });
    },
  );

  it("keeps unconfigured probes quiet with a custom-local marker", async () => {
    discoverMock.mockResolvedValue({ kind: "unreachable", error: new Error("offline") });
    const ctx = catalogContext();
    ctx.resolveProviderApiKey = () => ({ apiKey: "custom-local" });
    await expect(discoverLlamaServerProvider(ctx)).resolves.toBeNull();
  });

  it("keeps requested models and API keys isolated by agent runtime and auth profile", async () => {
    discoverMock.mockResolvedValueOnce(success()).mockResolvedValueOnce(success("second scope"));
    runtimeApiKeyMock
      .mockResolvedValueOnce("first-profile-key")
      .mockResolvedValueOnce("second-profile-key");
    const firstModel = await prepareLlamaServerDynamicModel(
      dynamicContext({ agentRuntimeId: "runtime-one", authProfileId: "profile-one" }),
    );
    const secondModel = await prepareLlamaServerDynamicModel(
      dynamicContext({ agentRuntimeId: "runtime-two", authProfileId: "profile-two" }),
    );

    expect(runtimeApiKeyMock.mock.calls).toMatchObject([
      [{ profileId: "profile-one" }],
      [{ profileId: "profile-two" }],
    ]);
    expect(discoverMock.mock.calls).toMatchObject([
      [{ apiKey: "first-profile-key" }],
      [{ apiKey: "second-profile-key" }],
    ]);
    expect([firstModel?.name, secondModel?.name]).toEqual(["org/model:Q4", "second scope"]);
  });

  it("prefers explicit Authorization over the profile API key during model preparation", async () => {
    runtimeApiKeyMock.mockResolvedValue("profile-key");
    discoverMock.mockResolvedValue(success());
    const headers = { Authorization: "Bearer endpoint-key" };

    await prepareLlamaServerDynamicModel(
      dynamicContext({
        providerConfig: { baseUrl: LOCAL_BASE_URL, headers },
      }),
    );

    expectDiscovery({ apiKey: undefined, headers });
  });

  it("returns no stale model when the server is unavailable", async () => {
    discoverMock.mockResolvedValueOnce(success()).mockResolvedValueOnce({
      kind: "unreachable",
      endpoint: success().endpoint,
      error: new Error("offline"),
    });
    const ctx = dynamicContext({
      agentRuntimeId: "failed-refresh-runtime",
    });

    await expect(prepareLlamaServerDynamicModel(ctx)).resolves.toMatchObject({
      id: "org/model:Q4",
    });
    await expect(prepareLlamaServerDynamicModel(ctx)).resolves.toBeUndefined();
  });
});
