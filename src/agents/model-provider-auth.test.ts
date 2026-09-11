// Verifies route-scoped auth and retained runtime preparation guards.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  ModelAuthAvailabilityEvaluation,
  ModelAuthAvailabilityRef,
} from "./model-auth-availability.js";

const syntheticAuthMocks = vi.hoisted(() => {
  const prepareSyntheticAuth = vi.fn<
    typeof import("../plugins/provider-runtime.js").prepareProviderSyntheticAuthWithPlugin
  >(async () => undefined);
  return {
    prepareProviderSyntheticAuthWithPlugin: prepareSyntheticAuth,
    resolveProviderSyntheticAuthWithPlugin: vi.fn(() => undefined),
  };
});

vi.mock("../plugins/provider-runtime.js", () => syntheticAuthMocks);

const modelAuthMocks = vi.hoisted(() => ({
  createRuntimeProviderAuthLookup: vi.fn(() => ({
    envApiKey: {
      aliasMap: {},
      candidateMap: {},
      authEvidenceMap: {},
    },
    syntheticAuthProviderRefs: [],
    syntheticAuthProviderRefsComplete: true,
  })),
  prepareRuntimeAvailableProviderAuth:
    vi.fn<typeof import("./model-auth-runtime.js").prepareRuntimeAvailableProviderAuth>(),
}));

const modelAuthAvailabilityMocks = vi.hoisted(() => {
  const evaluateModelAuth = vi.fn<
    (provider: string, ref?: ModelAuthAvailabilityRef) => ModelAuthAvailabilityEvaluation
  >(() => ({ availability: false, routeResolution: null }));
  return {
    evaluateModelAuth,
    createModelAuthAvailabilityResolver: vi.fn((_params: unknown) => ({
      evaluateModelAuth,
      evaluateRuntimeModelAuth: evaluateModelAuth,
      resolveProviderAuthAvailability: vi.fn(() => false),
      hasSyntheticAuth: vi.fn(() => false),
    })),
  };
});

const authProfilesMocks = vi.hoisted(() => ({
  ensureAuthProfileStoreWithoutExternalProfiles: vi.fn(() => ({ version: 1, profiles: {} })),
}));

vi.mock("./model-auth.js", () => modelAuthMocks);
vi.mock("./model-auth-availability.js", () => ({
  createModelAuthAvailabilityResolver:
    modelAuthAvailabilityMocks.createModelAuthAvailabilityResolver,
}));
vi.mock("./auth-profiles.js", () => authProfilesMocks);

const { createProviderAuthChecker } = await import("./model-provider-auth.js");

describe("model auth checker", () => {
  afterEach(() => {
    vi.clearAllMocks();
    modelAuthAvailabilityMocks.evaluateModelAuth.mockReturnValue({
      availability: false,
      routeResolution: null,
    });
  });

  it("consumes prepared native auth when checking runtime availability", async () => {
    const nativeAuth = { apiKey: "native-marker", source: "Native auth", mode: "oauth" as const };
    const prepared = createDeferredCore<typeof nativeAuth | undefined>();
    syntheticAuthMocks.prepareProviderSyntheticAuthWithPlugin.mockImplementationOnce(
      async () => await prepared.promise,
    );
    const { prepareRuntimeAvailableProviderAuth } =
      await vi.importActual<typeof import("./model-auth-runtime.js")>("./model-auth-runtime.js");
    let settled = false;
    const answer = prepareRuntimeAvailableProviderAuth({
      provider: "native",
      cfg: {},
      env: {},
      store: { version: 1, profiles: {} },
      runtimeLookup: {
        ...modelAuthMocks.createRuntimeProviderAuthLookup(),
        syntheticAuthProviderRefs: ["native"],
      },
    }).finally(() => {
      settled = true;
    });
    try {
      await expect
        .poll(() => syntheticAuthMocks.prepareProviderSyntheticAuthWithPlugin.mock.calls.length)
        .toBe(1);
      expect(settled).toBe(false);
      prepared.resolve(nativeAuth);
      await expect(answer).resolves.toBe(true);
      expect(syntheticAuthMocks.prepareProviderSyntheticAuthWithPlugin).toHaveBeenCalledOnce();
    } finally {
      prepared.resolve(undefined);
      await Promise.allSettled([answer]);
    }
  });

  it("honors cancellation before returning fast-path auth", async () => {
    const { prepareRuntimeAvailableProviderAuth } =
      await vi.importActual<typeof import("./model-auth-runtime.js")>("./model-auth-runtime.js");
    const lookup = modelAuthMocks.createRuntimeProviderAuthLookup();
    const params = {
      provider: "native",
      env: { NATIVE_FIXTURE_AUTH: "fixture-auth" },
      runtimeLookup: {
        ...lookup,
        envApiKey: { ...lookup.envApiKey, candidateMap: { native: ["NATIVE_FIXTURE_AUTH"] } },
      },
    };
    await expect(prepareRuntimeAvailableProviderAuth(params)).resolves.toBe(true);
    const reason = new Error("availability cancelled");
    await expect(
      prepareRuntimeAvailableProviderAuth({ ...params, signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    expect(syntheticAuthMocks.prepareProviderSyntheticAuthWithPlugin).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "does not prepare native auth for a managed SecretRef (available: %s)",
    async (available) => {
      const { prepareRuntimeAvailableProviderAuth } =
        await vi.importActual<typeof import("./model-auth-runtime.js")>("./model-auth-runtime.js");
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            "managed-native": {
              api: "openai-completions",
              apiKey: { source: "file", provider: "vault", id: "/native/key" },
              baseUrl: "https://example.test/v1",
              models: [],
            },
          },
        },
      };
      clearRuntimeConfigSnapshot();
      try {
        if (available) {
          const runtimeConfig = structuredClone(cfg);
          runtimeConfig.models!.providers!["managed-native"]!.apiKey = "runtime-auth-not-real";
          setRuntimeConfigSnapshot(runtimeConfig, cfg);
        }
        await expect(
          prepareRuntimeAvailableProviderAuth({
            provider: "managed-native",
            cfg,
            env: {},
            store: { version: 1, profiles: {} },
          }),
        ).resolves.toBe(available);
        expect(syntheticAuthMocks.prepareProviderSyntheticAuthWithPlugin).not.toHaveBeenCalled();
      } finally {
        clearRuntimeConfigSnapshot();
      }
    },
  );

  it("keeps tuple-aware null-artifact checks indeterminate with broad auth enabled", async () => {
    const cfg = {} as OpenClawConfig;
    const hasAuth = createProviderAuthChecker({ cfg });

    await expect(hasAuth("openai", { modelId: "gpt-5.5" })).resolves.toBe(false);

    expect(modelAuthMocks.createRuntimeProviderAuthLookup).toHaveBeenCalledWith({
      cfg,
      workspaceDir: undefined,
      env: undefined,
      includePluginSyntheticAuth: true,
    });
    expect(modelAuthAvailabilityMocks.createModelAuthAvailabilityResolver).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        allowPreparedRuntimeAuth: true,
        externalCliProviderIds: ["openai"],
        syntheticAuthProviderRefs: [],
      }),
    );
    expect(modelAuthMocks.prepareRuntimeAvailableProviderAuth).not.toHaveBeenCalled();
  });

  it("caches OpenAI auth by the complete route tuple", async () => {
    const hasAuth = createProviderAuthChecker({ cfg: {} as OpenClawConfig });
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

    expect(modelAuthAvailabilityMocks.evaluateModelAuth).toHaveBeenCalledTimes(2);
  });

  it("exposes the cached route evaluation alongside the boolean checker", async () => {
    const evaluation = {
      availability: true,
      routeResolution: null,
      evidence: "profile" as const,
    };
    modelAuthAvailabilityMocks.evaluateModelAuth.mockReturnValue(evaluation);
    const hasAuth = createProviderAuthChecker({ cfg: {} as OpenClawConfig });
    const ref = {
      modelId: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    };

    await expect(hasAuth.evaluateModelAuth("openai", ref)).resolves.toBe(evaluation);
    await expect(hasAuth("openai", { ...ref })).resolves.toBe(true);
    expect(modelAuthAvailabilityMocks.evaluateModelAuth).toHaveBeenCalledOnce();
  });

  it("uses shared model auth evaluation for a non-OpenAI AWS SDK model", async () => {
    const evaluation = {
      availability: true,
      routeResolution: null,
      selectedAuthMode: "aws-sdk",
      evidence: "aws-sdk" as const,
    };
    modelAuthAvailabilityMocks.evaluateModelAuth.mockReturnValue(evaluation);
    const hasAuth = createProviderAuthChecker({ cfg: {} as OpenClawConfig });
    const ref = {
      modelId: "us.anthropic.claude-sonnet-4-5",
      api: "bedrock-converse-stream",
    };

    await expect(hasAuth.evaluateModelAuth("amazon-bedrock", ref)).resolves.toBe(evaluation);
    await expect(hasAuth("amazon-bedrock", { ...ref })).resolves.toBe(true);
    expect(modelAuthAvailabilityMocks.evaluateModelAuth).toHaveBeenCalledWith(
      "amazon-bedrock",
      ref,
    );
    expect(modelAuthMocks.prepareRuntimeAvailableProviderAuth).not.toHaveBeenCalled();
  });

  it("does not let legacy provider auth override an unresolved model SecretRef", async () => {
    const evaluation = {
      availability: undefined,
      routeResolution: null,
      selectedAuthMode: "api-key",
      evidence: "provider-config" as const,
    };
    modelAuthAvailabilityMocks.evaluateModelAuth.mockReturnValue(evaluation);
    modelAuthMocks.prepareRuntimeAvailableProviderAuth.mockResolvedValue(true);
    const hasAuth = createProviderAuthChecker({ cfg: {} as OpenClawConfig });
    const ref = { modelId: "claude-sonnet-4-6", api: "anthropic-messages" };

    await expect(hasAuth.evaluateModelAuth("anthropic", ref)).resolves.toBe(evaluation);
    await expect(hasAuth("anthropic", { ...ref })).resolves.toBe(false);
    expect(modelAuthAvailabilityMocks.evaluateModelAuth).toHaveBeenCalledWith("anthropic", ref);
    expect(modelAuthMocks.prepareRuntimeAvailableProviderAuth).not.toHaveBeenCalled();
  });

  it("uses an explicit agent auth store directory for model auth checks", async () => {
    const cfg: OpenClawConfig = {};
    modelAuthAvailabilityMocks.evaluateModelAuth.mockReturnValue({
      availability: true,
      routeResolution: null,
    });
    const hasAuth = createProviderAuthChecker({
      cfg,
      agentDir: "/state/agents/worker/agent",
    });
    await expect(hasAuth("nvidia", { modelId: "fixture-model" })).resolves.toBe(true);
    expect(authProfilesMocks.ensureAuthProfileStoreWithoutExternalProfiles).toHaveBeenCalledWith(
      "/state/agents/worker/agent",
      { allowKeychainPrompt: false },
    );
    expect(modelAuthAvailabilityMocks.createModelAuthAvailabilityResolver).toHaveBeenCalledWith(
      expect.objectContaining({ cfg, agentDir: "/state/agents/worker/agent" }),
    );
  });
});
