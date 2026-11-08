import { afterEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { ModelAuthAvailabilityResolver } from "./model-auth-availability.js";

const synthetic = vi.hoisted(() => ({
  prepareProviderSyntheticAuthWithPlugin: vi.fn<
    typeof import("../plugins/provider-runtime.js").prepareProviderSyntheticAuthWithPlugin
  >(async () => undefined),
  resolveProviderSyntheticAuthWithPlugin: vi.fn(() => undefined),
}));

// mock-isolation: Control synthetic provider auth without loading bundled provider runtimes.
vi.mock("../plugins/provider-runtime.js", () => synthetic);

const auth = vi.hoisted(() => ({
  createRuntimeProviderAuthLookup: vi.fn(() => ({
    envApiKey: { aliasMap: {}, candidateMap: {}, authEvidenceMap: {} },
    syntheticAuthProviderRefs: [],
  })),
}));

const evaluateModelAuth = vi.hoisted(() =>
  vi.fn<ModelAuthAvailabilityResolver["evaluateModelAuth"]>(() => ({
    availability: false,
    routeResolution: null,
  })),
);

// mock-isolation: Supply prepared auth lookups without reading real provider credentials.
vi.mock("./model-auth.js", () => auth);
// mock-isolation: Keep auth availability decisions in the suite's controlled resolver.
vi.mock("./model-auth-availability.js", () => ({
  createModelAuthAvailabilityResolver: vi.fn((_params: unknown) => ({
    evaluateModelAuth,
  })),
}));
// mock-isolation: Use an empty synthetic profile store rather than operator auth state.
vi.mock("./auth-profiles.js", () => ({
  ensureAuthProfileStoreWithoutExternalProfilesAsync: vi.fn(() => ({ version: 1, profiles: {} })),
}));

const { createProviderAuthChecker } = await import("./model-provider-auth.js");
const { prepareRuntimeAvailableProviderAuth: prepareAuth } =
  await vi.importActual<typeof import("./model-auth-runtime.js")>("./model-auth-runtime.js");
function managedConfig(apiKey: ModelProviderConfig["apiKey"]): OpenClawConfig {
  const provider: ModelProviderConfig = {
    api: "openai-completions",
    apiKey,
    baseUrl: "https://example.test/v1",
    models: [],
  };
  return { models: { providers: { "managed-native": provider } } };
}
const prepare = (params: Parameters<typeof prepareAuth>[0]) =>
  prepareAuth({ cfg: {}, env: {}, store: { version: 1, profiles: {} }, ...params });

describe("model auth checker", () => {
  afterEach(() => {
    vi.clearAllMocks();
    clearRuntimeConfigSnapshot();
    evaluateModelAuth.mockReturnValue({ availability: false, routeResolution: null });
  });

  it("consumes prepared native auth when checking runtime availability", async () => {
    const nativeAuth = { apiKey: "native-marker", source: "Native auth", mode: "oauth" as const };
    const prepared = createDeferredCore<typeof nativeAuth | undefined>();
    synthetic.prepareProviderSyntheticAuthWithPlugin.mockImplementationOnce(
      async () => await prepared.promise,
    );
    let settled = false;
    const answer = prepare({
      provider: "native",
      runtimeLookup: {
        ...auth.createRuntimeProviderAuthLookup(),
        syntheticAuthProviderRefs: ["native"],
      },
    }).finally(() => {
      settled = true;
    });
    try {
      await expect
        .poll(() => synthetic.prepareProviderSyntheticAuthWithPlugin.mock.calls.length)
        .toBe(1);
      expect(settled).toBe(false);
      prepared.resolve(nativeAuth);
      await expect(answer).resolves.toBe(true);
    } finally {
      prepared.resolve(undefined);
      await Promise.allSettled([answer]);
    }
  });

  it("does not prepare native auth for an unresolved managed SecretRef", async () => {
    const cfg = managedConfig({ source: "file", provider: "vault", id: "/native/key" });
    await expect(prepare({ provider: "managed-native", cfg })).resolves.toBe(false);
    expect(synthetic.prepareProviderSyntheticAuthWithPlugin).not.toHaveBeenCalled();
  });

  it("caches OpenAI auth by the complete route tuple", async () => {
    const hasAuth = createProviderAuthChecker({ cfg: {} });
    const platformRef = {
      modelId: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    };

    await hasAuth("openai", platformRef);
    await hasAuth("openai", { ...platformRef });
    await hasAuth("openai", {
      ...platformRef,
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });

    expect(evaluateModelAuth).toHaveBeenCalledTimes(2);
  });

  it("retries a rejected route evaluation while sharing concurrent callers", async () => {
    const failure = new Error("catalog unavailable");
    evaluateModelAuth.mockImplementationOnce(() => {
      throw failure;
    });
    const hasAuth = createProviderAuthChecker({ cfg: {} });
    const ref = { modelId: "fixture-model" };
    const first = hasAuth.evaluateModelAuth("fixture", ref);
    const concurrent = hasAuth.evaluateModelAuth("fixture", { ...ref });
    await expect(first).rejects.toBe(failure);
    await expect(concurrent).rejects.toBe(failure);
    expect(evaluateModelAuth).toHaveBeenCalledOnce();

    evaluateModelAuth.mockReturnValue({ availability: true, routeResolution: null });
    await expect(hasAuth("fixture", ref)).resolves.toBe(true);
    expect(evaluateModelAuth).toHaveBeenCalledTimes(2);
  });

  it("preserves an unresolved model SecretRef evaluation as unavailable", async () => {
    const evaluation = {
      availability: undefined,
      routeResolution: null,
      selectedAuthMode: "api-key",
      evidence: "provider-config" as const,
    };
    evaluateModelAuth.mockReturnValue(evaluation);
    const hasAuth = createProviderAuthChecker({ cfg: {} });
    const ref = { modelId: "claude-sonnet-4-6", api: "anthropic-messages" };

    await expect(hasAuth.evaluateModelAuth("anthropic", ref)).resolves.toBe(evaluation);
    await expect(hasAuth("anthropic", { ...ref })).resolves.toBe(false);
  });
});
