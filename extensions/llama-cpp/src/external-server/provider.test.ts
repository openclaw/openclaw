import type {
  ProviderCatalogContext,
  ProviderPrepareDynamicModelContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { beforeEach, expect, it, vi } from "vitest";
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

const baseUrl = "http://localhost:8080/v1";
const success = (name = "model") => successfulDiscovery(undefined, { id: "model", name });
function discover(
  provider?: Partial<ModelProviderConfig>,
  auth: ReturnType<ProviderCatalogContext["resolveProviderApiKey"]> = { apiKey: undefined },
) {
  const config: ProviderCatalogContext["config"] = {};
  if (provider) {
    config.models = { providers: { "llama-cpp": { baseUrl, models: [], ...provider } } };
  }
  return discoverLlamaServerProvider({
    config,
    env: {},
    resolveProviderApiKey: () => auth,
    resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
  });
}
function prepare(overrides: Partial<ProviderPrepareDynamicModelContext> = {}) {
  return prepareLlamaServerDynamicModel({
    config: {},
    provider: "llama-cpp",
    modelId: "model",
    modelRegistry: {} as never,
    providerConfig: { baseUrl, api: "openai-completions" },
    ...overrides,
  });
}
function expectDiscovery(params: Record<string, unknown>) {
  expect(discoverMock).toHaveBeenCalledWith(expect.objectContaining(params));
}
beforeEach(() => {
  discoverMock.mockReset();
  runtimeApiKeyMock.mockReset().mockResolvedValue(undefined);
});

it.each([false, true])("catalog honors explicit Authorization: %s", async (explicit) => {
  discoverMock.mockResolvedValue(success());
  const headers = { Authorization: "Bearer proxy-key" };
  const result = await discover(explicit ? { headers } : undefined, {
    apiKey: "LLAMA_SERVER_API_KEY",
    discoveryApiKey: "profile-key",
    profileId: "llama-cpp:default",
  });
  expect(result?.outcomes).toEqual([
    {
      provider: "llama-cpp",
      status: "ready",
      ...(!explicit && { profileId: "llama-cpp:default" }),
    },
  ]);
  expectDiscovery(explicit ? { apiKey: undefined, headers } : { apiKey: "profile-key" });
});

it.each([
  {
    failure: { kind: "http-error", status: 401 },
    outcome: { status: "auth-rejected", rejectionScope: "catalog" },
  },
  { failure: { kind: "http-error", status: 503 }, outcome: { status: "unavailable" } },
  {
    failure: { kind: "unreachable", error: new Error("offline") },
    outcome: { status: "unavailable" },
  },
])("reports $failure without publishing stale models", async ({ failure, outcome }) => {
  discoverMock.mockResolvedValue({ ...failure, endpoint: success().endpoint });
  await expect(discover({ models: success().models.map(({ config }) => config) })).resolves.toEqual(
    {
      providers: {},
      outcomes: [{ provider: "llama-cpp", ...outcome }],
    },
  );
});

it("keeps unconfigured probes quiet with a custom-local marker", async () => {
  discoverMock.mockResolvedValue({ kind: "unreachable", error: new Error("offline") });
  await expect(discover(undefined, { apiKey: "custom-local" })).resolves.toBeNull();
});

it("isolates dynamic models by agent runtime and auth profile", async () => {
  runtimeApiKeyMock.mockImplementation(({ profileId }: { profileId: string }) => profileId);
  discoverMock.mockImplementation(({ apiKey }: { apiKey: string }) => success(apiKey));
  const first = await prepare({ agentRuntimeId: "runtime-one", authProfileId: "profile-one" });
  const second = await prepare({ agentRuntimeId: "runtime-two", authProfileId: "profile-two" });
  expect([first?.name, second?.name]).toEqual(["profile-one", "profile-two"]);
});

it("prefers explicit Authorization during model preparation", async () => {
  runtimeApiKeyMock.mockResolvedValue("profile-key");
  discoverMock.mockResolvedValue(success());
  const headers = { Authorization: "Bearer endpoint-key" };
  await prepare({ providerConfig: { baseUrl, headers } });
  expectDiscovery({ apiKey: undefined, headers });
});

it("returns no stale model when the server is unavailable", async () => {
  discoverMock.mockResolvedValueOnce(success()).mockResolvedValueOnce({
    kind: "unreachable",
    endpoint: success().endpoint,
    error: new Error("offline"),
  });
  const context = { agentRuntimeId: "failed-refresh-runtime" };
  await expect(prepare(context)).resolves.toMatchObject({ id: "model" });
  await expect(prepare(context)).resolves.toBeUndefined();
});
