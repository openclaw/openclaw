import * as modelCatalogRefs from "@openclaw/model-catalog-core/model-catalog-refs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import {
  resolveModelRouteIntent,
  resolveModelRuntimePolicy as resolveModelRuntimePolicyBase,
} from "./model-runtime-policy.js";

function agentModels(runtimes: Record<string, string>): OpenClawConfig {
  return {
    agents: {
      defaults: {
        models: Object.fromEntries(
          Object.entries(runtimes).map(([ref, id]) => [ref, { agentRuntime: { id } }]),
        ),
      },
    },
  };
}

function expectPolicy(
  params: Parameters<typeof resolveModelRuntimePolicy>[0],
  expected: ReturnType<typeof resolveModelRuntimePolicy>,
) {
  expect(resolveModelRuntimePolicy(params)).toEqual(expected);
}

const modelPolicy = (id: string, matchedProvider?: string) => ({
  policy: { id },
  source: "model" as const,
  ...(matchedProvider ? { matchedProvider } : {}),
});

describe("model route intent", () => {
  const config: OpenClawConfig = {
    agents: {
      entries: {
        assistant: {},
        billing: { models: { "openai/gpt-5.4-mini": { agentRuntime: { id: "openclaw" } } } },
      },
      defaults: {
        model: "openai/gpt-5.5",
        models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
      },
    },
  };

  it("inherits only the selected agent's same-provider primary route", () => {
    const resolve = (provider: string, modelId: string) =>
      resolveModelRouteIntent({ config, provider, modelId, agentId: "assistant" });
    expect(resolve("openai", "gpt-5.4-mini")).toEqual({ runtimeId: "codex", source: "inherited" });
    expect(resolve("anthropic", "claude-sonnet-4-6")).toBeUndefined();
  });

  it("keeps a consumer's explicit runtime ahead of the default route", () => {
    expect(
      resolveModelRouteIntent({
        config,
        provider: "openai",
        modelId: "gpt-5.4-mini",
        agentId: "billing",
      }),
    ).toEqual({ runtimeId: "openclaw", source: "explicit" });
  });

  it.each([false, true])("inherits native runtime and billing policy (ACP=%s)", (acp) => {
    const cfg: OpenClawConfig = {
      ...config,
      auth: {
        profiles: {
          "openai:native": { provider: "openai", mode: "api_key" },
          "openai:harness": { provider: "openai", mode: "oauth" },
        },
      },
      agents: {
        defaults: { ...config.agents?.defaults, model: "openai/gpt-5.5@openai:native" },
        entries: {
          assistant: {
            model: "openai/harness-model@openai:harness",
            ...(acp ? { runtime: { type: "acp" } } : {}),
          },
        },
      },
    };
    expect(
      resolveModelRouteIntent({
        config: cfg,
        provider: "openai",
        modelId: "gpt-5.4-mini",
        agentId: "assistant",
        primaryModel: { provider: "openai", model: acp ? "gpt-5.5" : "harness-model" },
      }),
    ).toEqual(
      acp
        ? { runtimeId: "codex", authRequirement: "api-key", source: "inherited" }
        : { authRequirement: "subscription", source: "inherited" },
    );
  });
});

function resolveModelRuntimePolicy(
  params: Parameters<typeof resolveModelRuntimePolicyBase>[0],
): ReturnType<typeof resolveModelRuntimePolicyBase> {
  return resolveModelRuntimePolicyBase({
    ...params,
    config: createCanonicalAgentConfigFixture(params.config).config,
  });
}

const createModelConfig = (
  agentRuntimeId: string,
  modelId = "qwen-local",
): ModelDefinitionConfig => ({
  id: modelId,
  name: "Qwen Local",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_768,
  maxTokens: 4096,
  agentRuntime: { id: agentRuntimeId },
});

function providerConfig(provider: string, value: ModelProviderConfig): OpenClawConfig {
  return { models: { providers: { [provider]: value } } };
}

const qaConfig = () =>
  providerConfig("openai", {
    baseUrl: "https://api.openai.example/v1",
    agentRuntime: { id: "codex" },
    models: [],
  });

afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

describe("resolveModelRuntimePolicy", () => {
  it.each(["immutable", "published"])(
    "prepares each %s agent model policy inventory once and observes replacement",
    (owner) => {
      const models = Object.fromEntries(
        Array.from({ length: 24 }, (_, index) => [
          `fixture/model-${index}`,
          { agentRuntime: { id: "first-runtime" } },
        ]),
      );
      const prepare = (config: OpenClawConfig) => {
        if (owner === "immutable") {
          return freezeJsonSnapshot(config);
        }
        setRuntimeConfigSnapshot(config);
        return config;
      };
      const config = prepare({ agents: { defaults: { models } } });
      const resolve = (captured: OpenClawConfig, modelId = "model-23") =>
        resolveModelRuntimePolicyBase({ config: captured, provider: "fixture", modelId });
      using parse = vi.spyOn(modelCatalogRefs, "parseModelCatalogRef");
      for (const modelId of ["model-23", "model-0", "model-12"]) {
        expect(resolve(config, modelId)).toEqual(modelPolicy("first-runtime", "fixture"));
      }
      expect(parse.mock.calls.length).toBeLessThanOrEqual(Object.keys(models).length + 6);

      if (owner === "published") {
        for (const restart of [false, true]) {
          if (restart) {
            clearRuntimeConfigSnapshot();
          }
          models["fixture/model-23"] = {
            agentRuntime: { id: restart ? "restarted" : "republished" },
          };
          prepare(config);
          expect(resolve(config).policy?.id).toBe(restart ? "restarted" : "republished");
        }
      }

      const replacement = agentModels({ "fixture/model-23": "next-runtime" });
      expect(resolve(prepare(replacement))).toEqual(modelPolicy("next-runtime", "fixture"));

      const mutablePolicy = { id: "mutable-runtime" };
      const mutable: OpenClawConfig = {
        agents: { defaults: { models: { "fixture/model-23": { agentRuntime: mutablePolicy } } } },
      };
      expect(resolve(mutable).policy?.id).toBe("mutable-runtime");
      mutablePolicy.id = "edited-runtime";
      expect(resolve(mutable).policy?.id).toBe("edited-runtime");
    },
  );

  it("bounds reference parsing when resolving a large provider catalog", () => {
    const models = Array.from({ length: 500 }, (_, index) =>
      createModelConfig("openclaw", `ollama/org/model-${String(index).padStart(4, "0")}`),
    );
    const config = providerConfig("ollama", { baseUrl: "http://127.0.0.1:11434", models });
    using parse = vi.spyOn(modelCatalogRefs, "parseModelCatalogRef");

    for (const model of models) {
      expect(
        resolveModelRuntimePolicyBase({
          config,
          provider: "ollama",
          modelId: model.id.slice("ollama/".length),
        }),
      ).toEqual(modelPolicy("openclaw"));
    }

    // Projection must not parse the full provider inventory again for every model.
    expect(parse.mock.calls.length).toBeLessThanOrEqual(models.length * 2);
  });

  it.each([
    ["unset gate", undefined, "openclaw", { policy: { id: "codex" }, source: "provider" }],
    [
      "enabled gate",
      "1",
      "openclaw",
      { policy: { id: "openclaw" }, source: "model", forcedByEnvironment: true },
    ],
    ["invalid override", "1", "bogus", { policy: { id: "codex" }, source: "provider" }],
  ] as const)("gates the private QA runtime override: %s", (_name, gate, runtime, expected) => {
    vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", gate);
    vi.stubEnv("OPENCLAW_QA_FORCE_RUNTIME", runtime);
    expectPolicy({ config: qaConfig(), provider: "openai", modelId: "gpt-5.5" }, expected);
  });

  it.each(["qwen-local", undefined])("honors provider wildcard policies (model=%s)", (modelId) => {
    const config = agentModels({ "vllm/*": "openclaw" });
    if (modelId) {
      config.agents = {
        ...config.agents,
        ownership: "explicit",
        entries: { ops: {}, research: {} },
      };
    }
    expectPolicy({ config, provider: "vllm", modelId }, modelPolicy("openclaw", "vllm"));
  });

  it("prefers exact provider model runtime policy over agent provider wildcards", () => {
    const config: OpenClawConfig = {
      ...agentModels({ "vllm/*": "openclaw" }),
      ...providerConfig("vllm", {
        baseUrl: "http://127.0.0.1:11434/v1",
        models: [createModelConfig("codex")],
      }),
    };
    expectPolicy({ config, provider: "vllm", modelId: "qwen-local" }, modelPolicy("codex"));
  });

  it("matches self-qualified provider rows only by their full model id", () => {
    const config = providerConfig("vllm", {
      baseUrl: "http://127.0.0.1:11434/v1",
      models: [
        createModelConfig("openclaw", "other/qwen-local"),
        createModelConfig("codex", " vllm/qwen-local "),
      ],
    });

    expectPolicy({ config, provider: "vllm", modelId: "local" }, {});
  });

  it("honors the OpenRouter provider model policy for an inferred provider and provider-owned model id", () => {
    const config = providerConfig("openrouter", {
      baseUrl: "https://openrouter.ai/api/v1",
      agentRuntime: { id: "codex" },
      models: [createModelConfig("openclaw", "anthropic/claude-opus-4.6")],
    });

    expectPolicy(
      { config, provider: "", modelId: "openrouter/anthropic/claude-opus-4.6" },
      modelPolicy("openclaw", "openrouter"),
    );
  });

  it("uses provider-qualified model ids to resolve provider runtime policies", () => {
    const config = providerConfig("anthropic", {
      baseUrl: "https://api.anthropic.example/v1",
      agentRuntime: { id: "claude-cli" },
      models: [],
    });

    expect(
      resolveModelRuntimePolicy({
        config,
        provider: "",
        modelId: "anthropic/claude-opus-4-7",
      }),
    ).toEqual({
      policy: { id: "claude-cli" },
      source: "provider",
      matchedProvider: "anthropic",
    });
  });

  it("prefers provider-qualified agent entries over bare entries for inferred providers", () => {
    const config = agentModels({
      "claude-opus-4-7": "openclaw",
      "anthropic/claude-opus-4-7": "claude-cli",
    });
    expectPolicy(
      { config, provider: "", modelId: "anthropic/claude-opus-4-7" },
      modelPolicy("claude-cli", "anthropic"),
    );
  });

  it("matches a provider wildcard agent model entry when the caller provider is empty", () => {
    expectPolicy(
      {
        config: agentModels({ "anthropic/*": "claude-cli" }),
        provider: "",
        modelId: "claude-opus-4-7[1m]",
      },
      modelPolicy("claude-cli", "anthropic"),
    );
  });

  it("uses the persisted owner model runtime policy for a bare session key", () => {
    const config = {
      session: { store: "/stores/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: {
          sessionStore: { agentId: "research" },
          models: {
            "vllm/qwen-local": { agentRuntime: { id: "codex" } },
          },
        },
        entries: {
          ops: {},
          research: {
            models: {
              "vllm/qwen-local": { agentRuntime: { id: "openclaw" } },
            },
          },
        },
      },
    } as OpenClawConfig;

    const params = { config, provider: "vllm", modelId: "qwen-local", sessionKey: "global" };
    expectPolicy(params, modelPolicy("openclaw", "vllm"));
    expect(() => resolveModelRuntimePolicy({ ...params, agentId: "ops" })).toThrow(
      /belongs to "research"/,
    );
  });

  it("uses a prepared stored-row owner for openai/* without re-admitting global", () => {
    const config: OpenClawConfig = {
      session: { store: "/synthetic/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: {
          main: { models: { "openai/*": { agentRuntime: { id: "openclaw" } } } },
          ops: { models: { "openai/*": { agentRuntime: { id: "codex" } } } },
        },
      },
    };
    expect(
      resolveModelRuntimePolicy({
        config,
        provider: "openai",
        modelId: "gpt-5.5",
        sessionKey: "global",
        agentScope: { kind: "prepared", agentId: "main" },
      }),
    ).toEqual(modelPolicy("openclaw", "openai"));
  });

  it("fails closed for duplicate provider-prefixed bare-model policies", () => {
    const config = agentModels({
      "openai/foo-1": "codex",
      "anthropic/foo-1": "claude-cli",
      "anthropic/*": "claude-cli",
    });
    expectPolicy({ config, provider: "", modelId: "foo-1" }, {});
  });
});
