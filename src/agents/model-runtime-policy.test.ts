// Covers model runtime policy precedence and private QA runtime overrides.
import { afterEach, describe, expect, it } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import {
  resolveModelRouteIntent,
  resolveModelRuntimePolicy as resolveModelRuntimePolicyBase,
} from "./model-runtime-policy.js";

const ORIGINAL_BUILD_PRIVATE_QA = process.env.OPENCLAW_BUILD_PRIVATE_QA;
const ORIGINAL_QA_FORCE_RUNTIME = process.env.OPENCLAW_QA_FORCE_RUNTIME;

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
    expect(
      resolveModelRouteIntent({
        config,
        provider: "openai",
        modelId: "gpt-5.4-mini",
        agentId: "assistant",
      }),
    ).toEqual({ runtimeId: "codex", source: "inherited" });
    expect(
      resolveModelRouteIntent({
        config,
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        agentId: "assistant",
      }),
    ).toBeUndefined();
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

  it.each([
    { acp: false, prepared: true },
    { acp: true, prepared: true },
  ])(
    "inherits native runtime and billing policy (ACP=$acp prepared=$prepared)",
    ({ acp, prepared }) => {
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
          ...(prepared
            ? { primaryModel: { provider: "openai", model: acp ? "gpt-5.5" : "harness-model" } }
            : {}),
        }),
      ).toEqual(
        acp
          ? { runtimeId: "codex", authRequirement: "api-key", source: "inherited" }
          : { authRequirement: "subscription", source: "inherited" },
      );
    },
  );
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
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 32_768,
  maxTokens: 4096,
  agentRuntime: { id: agentRuntimeId },
});

function restoreEnv(
  name: "OPENCLAW_BUILD_PRIVATE_QA" | "OPENCLAW_QA_FORCE_RUNTIME",
  value: string | undefined,
): void {
  // Tests mutate private QA env gates; restore exact process state after each.
  if (value == null) {
    deleteTestEnvValue(name);
    return;
  }
  setTestEnvValue(name, value);
}

function makeProviderRuntimeConfig(runtime: string): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.example/v1",
          agentRuntime: { id: runtime },
          models: [],
        },
      },
    },
  } as OpenClawConfig;
}

afterEach(() => {
  restoreEnv("OPENCLAW_BUILD_PRIVATE_QA", ORIGINAL_BUILD_PRIVATE_QA);
  restoreEnv("OPENCLAW_QA_FORCE_RUNTIME", ORIGINAL_QA_FORCE_RUNTIME);
});

describe("resolveModelRuntimePolicy", () => {
  it.each(["inherited"])(
    "keeps wildcard policy when %s has no own enumerable runtime entry",
    (modelId) => {
      const models = {
        "fixture/alias-only": { alias: "display-name" },
        "fixture/*": { agentRuntime: { id: "wildcard-runtime" } },
      };
      Object.setPrototypeOf(models, {
        "fixture/inherited": { agentRuntime: { id: "inherited-runtime" } },
      });
      Object.defineProperty(models, "fixture/hidden", {
        value: { agentRuntime: { id: "hidden-runtime" } },
        enumerable: false,
      });
      expect(
        resolveModelRuntimePolicyBase({
          config: { agents: { defaults: { models } } },
          provider: "fixture",
          modelId,
        }),
      ).toEqual({
        policy: { id: "wildcard-runtime" },
        source: "model",
        matchedProvider: "fixture",
      });
    },
  );

  it("ignores the QA force-runtime override when the private QA gate is unset", () => {
    deleteTestEnvValue("OPENCLAW_BUILD_PRIVATE_QA");
    setTestEnvValue("OPENCLAW_QA_FORCE_RUNTIME", "openclaw");

    expect(
      resolveModelRuntimePolicy({
        config: makeProviderRuntimeConfig("codex"),
        provider: "openai",
        modelId: "gpt-5.5",
      }),
    ).toEqual({
      policy: { id: "codex" },
      source: "provider",
    });
  });

  it("respects the QA force-runtime override when the private QA gate is set", () => {
    // The force-runtime override is intentionally gated to private QA builds so
    // normal users cannot accidentally change model runtime selection via env.
    setTestEnvValue("OPENCLAW_BUILD_PRIVATE_QA", "1");
    setTestEnvValue("OPENCLAW_QA_FORCE_RUNTIME", "openclaw");

    expect(
      resolveModelRuntimePolicy({
        config: makeProviderRuntimeConfig("codex"),
        provider: "openai",
        modelId: "gpt-5.5",
      }),
    ).toEqual({
      policy: { id: "openclaw" },
      source: "model",
      forcedByEnvironment: true,
    });
  });

  it("ignores invalid QA force-runtime values even when the private QA gate is set", () => {
    setTestEnvValue("OPENCLAW_BUILD_PRIVATE_QA", "1");
    setTestEnvValue("OPENCLAW_QA_FORCE_RUNTIME", "bogus");

    expect(
      resolveModelRuntimePolicy({
        config: makeProviderRuntimeConfig("codex"),
        provider: "openai",
        modelId: "gpt-5.5",
      }),
    ).toEqual({
      policy: { id: "codex" },
      source: "provider",
    });
  });

  it("honors provider wildcard agent model runtime policy entries", () => {
    const config = {
      agents: {
        ownership: "explicit",
        entries: { ops: {}, research: {} },
        defaults: {
          models: {
            "vllm/*": { agentRuntime: { id: "openclaw" } },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveModelRuntimePolicy({
        config,
        provider: "vllm",
        modelId: "qwen-local",
      }),
    ).toEqual({
      policy: { id: "openclaw" },
      source: "model",
      matchedProvider: "vllm",
    });
  });

  it("honors provider wildcard agent model runtime policy entries without a concrete model id", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "vllm/*": { agentRuntime: { id: "openclaw" } },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveModelRuntimePolicy({
        config,
        provider: "vllm",
      }),
    ).toEqual({
      policy: { id: "openclaw" },
      source: "model",
      matchedProvider: "vllm",
    });
  });

  it("prefers exact provider model runtime policy over agent provider wildcards", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "vllm/*": { agentRuntime: { id: "openclaw" } },
          },
        },
      },
      models: {
        providers: {
          vllm: {
            baseUrl: "http://127.0.0.1:11434/v1",
            models: [createModelConfig("codex")],
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveModelRuntimePolicy({
        config,
        provider: "vllm",
        modelId: "qwen-local",
      }),
    ).toEqual({
      policy: { id: "codex" },
      source: "model",
    });
  });

  it.each([
    {
      name: "provider-owned model id",
      modelId: "anthropic/claude-opus-4.6",
    },
  ])("honors the OpenRouter agent model policy for a $name", ({ modelId }) => {
    const config = {
      agents: {
        defaults: {
          models: {
            "openrouter/anthropic/claude-opus-4.6": {
              agentRuntime: { id: "openclaw" },
            },
            "anthropic/claude-opus-4.6": {
              agentRuntime: { id: "claude-cli" },
            },
          },
        },
      },
      models: {
        providers: {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            agentRuntime: { id: "codex" },
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveModelRuntimePolicy({
        config,
        provider: "openrouter",
        modelId,
      }),
    ).toEqual({
      policy: { id: "openclaw" },
      source: "model",
      matchedProvider: "openrouter",
    });
  });

  it.each([
    {
      name: "inferred provider and provider-owned model id",
      provider: "",
      modelId: "openrouter/anthropic/claude-opus-4.6",
      matchedProvider: "openrouter",
    },
  ])(
    "honors the OpenRouter provider model policy for a $name",
    ({ provider, modelId, matchedProvider }) => {
      const config = {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.ai/api/v1",
              agentRuntime: { id: "codex" },
              models: [createModelConfig("openclaw", "anthropic/claude-opus-4.6")],
            },
          },
        },
      } as OpenClawConfig;

      expect(resolveModelRuntimePolicy({ config, provider, modelId })).toEqual({
        policy: { id: "openclaw" },
        source: "model",
        ...(matchedProvider ? { matchedProvider } : {}),
      });
    },
  );

  it("uses provider-qualified model ids to resolve provider runtime policies", () => {
    const config = {
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.example/v1",
            agentRuntime: { id: "claude-cli" },
            models: [],
          },
        },
      },
    } as OpenClawConfig;

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
    const config = {
      agents: {
        defaults: {
          models: {
            "claude-opus-4-7": { agentRuntime: { id: "openclaw" } },
            "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveModelRuntimePolicy({
        config,
        provider: "",
        modelId: "anthropic/claude-opus-4-7",
      }),
    ).toEqual({
      policy: { id: "claude-cli" },
      source: "model",
      matchedProvider: "anthropic",
    });
  });

  it("matches a provider wildcard agent model entry when the caller provider is empty", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "anthropic/*": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveModelRuntimePolicy({
        config,
        provider: "",
        modelId: "claude-opus-4-7[1m]",
      }),
    ).toEqual({
      policy: { id: "claude-cli" },
      source: "model",
      matchedProvider: "anthropic",
    });
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

    expect(
      resolveModelRuntimePolicy({
        config,
        provider: "vllm",
        modelId: "qwen-local",
        sessionKey: "global",
      }),
    ).toEqual({
      policy: { id: "openclaw" },
      source: "model",
      matchedProvider: "vllm",
    });
    expect(() =>
      resolveModelRuntimePolicy({
        config,
        provider: "vllm",
        modelId: "qwen-local",
        agentId: "ops",
        sessionKey: "global",
      }),
    ).toThrow(/belongs to "research"/);
  });

  it.each(["openai/*"])(
    "uses a prepared stored-row owner for %s without re-admitting global",
    (modelKey) => {
      const config: OpenClawConfig = {
        session: { store: "/synthetic/shared.sqlite" },
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: {
            main: { models: { [modelKey]: { agentRuntime: { id: "openclaw" } } } },
            ops: { models: { [modelKey]: { agentRuntime: { id: "codex" } } } },
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
      ).toEqual({ policy: { id: "openclaw" }, source: "model", matchedProvider: "openai" });
    },
  );

  it("fails closed for duplicate provider-prefixed bare-model policies", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "openai/foo-1": { agentRuntime: { id: "codex" } },
            "anthropic/foo-1": { agentRuntime: { id: "claude-cli" } },
            "anthropic/*": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveModelRuntimePolicy({
        config,
        provider: "",
        modelId: "foo-1",
      }),
    ).toEqual({});
  });
});
