import { describe, expect, it } from "vitest";
// Coverage for small run-attempt decision helpers.
import type { OpenClawConfig } from "../../../config/config.js";
import {
  countProviderNativeToolsForPrecheck,
  resolveAttemptPromptModeAndSkillsPrompt,
  resolveAttemptStreamAuthProfileId,
  resolveAttemptToolPolicyMessageProvider,
  resolveEmbeddedAttemptSessionWriteLockOptions,
  resolveUnknownToolGuardThreshold,
  shouldRunLlmOutputHooksForAttempt,
} from "./attempt.run-decisions.js";

describe("resolveEmbeddedAttemptSessionWriteLockOptions", () => {
  it("bounds post-prompt session lock max hold to compaction timeout instead of run timeout", () => {
    // Cleanup writes should not inherit the full model run timeout; the
    // compaction window is the larger session-write risk.
    const options = resolveEmbeddedAttemptSessionWriteLockOptions({
      config: {},
      compactionTimeoutMs: 600_000,
      env: {},
    });

    expect(options.maxHoldMs).toBe(720_000);
  });
});

describe("resolveAttemptStreamAuthProfileId", () => {
  it("uses only the runtime-forwarded auth profile for stream provenance", () => {
    // Raw attempt authProfileId may be a session selection detail; stream
    // provenance should only expose the runtime-forwarded profile.
    expect(
      resolveAttemptStreamAuthProfileId({
        authProfileId: "openai:raw-session-profile",
        runtimePlan: {
          auth: {
            forwardedAuthProfileId: "openai:forwarded-profile",
          },
        } as never,
      }),
    ).toBe("openai:forwarded-profile");

    expect(
      resolveAttemptStreamAuthProfileId({
        authProfileId: "openai:non-forwarded-profile",
        runtimePlan: {
          auth: {},
        } as never,
      }),
    ).toBeUndefined();
  });
});

describe("countProviderNativeToolsForPrecheck", () => {
  const codexNativeConfig = {
    auth: {
      profiles: {
        "openai:test": {
          provider: "openai",
          mode: "oauth",
        },
      },
    },
    tools: {
      web: {
        search: {
          enabled: true,
          openaiCodex: { enabled: true, mode: "cached" },
        },
      },
    },
  } satisfies OpenClawConfig;
  const openAIChatGptResponsesModel = {
    api: "openai-chatgpt-responses",
    id: "gpt-5.5",
    provider: "openai",
  };
  const openAIResponsesModel = {
    api: "openai-responses",
    id: "gpt-5.5",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
  };

  const nativeToolCases: {
    name: string;
    config: OpenClawConfig;
    model: { api?: unknown; id?: unknown; provider?: unknown; baseUrl?: unknown };
    expectedCount: number;
  }[] = [
    {
      name: "native Codex search active",
      config: codexNativeConfig,
      model: openAIChatGptResponsesModel,
      expectedCount: 1,
    },
    { name: "default OpenAI Responses", config: {}, model: openAIResponsesModel, expectedCount: 1 },
    {
      name: "disabled OpenAI Responses web search",
      config: { tools: { web: { search: { enabled: false } } } },
      model: openAIResponsesModel,
      expectedCount: 0,
    },
    {
      name: "OpenAI Responses custom base URL",
      config: {},
      model: {
        ...openAIResponsesModel,
        baseUrl: "https://proxy.example.invalid/v1",
      },
      expectedCount: 0,
    },
    {
      name: "OpenAI Responses non-native search provider",
      config: { tools: { web: { search: { provider: "brave" } } } },
      model: openAIResponsesModel,
      expectedCount: 0,
    },
    {
      name: "disabled web search",
      config: {
        ...codexNativeConfig,
        tools: { web: { search: { enabled: false, openaiCodex: { enabled: true } } } },
      },
      model: openAIChatGptResponsesModel,
      expectedCount: 0,
    },
    {
      name: "disabled native Codex search",
      config: {
        ...codexNativeConfig,
        tools: { web: { search: { enabled: true, openaiCodex: { enabled: false } } } },
      },
      model: openAIChatGptResponsesModel,
      expectedCount: 0,
    },
    {
      name: "OpenAI Responses API with Codex native config",
      config: codexNativeConfig,
      model: openAIResponsesModel,
      expectedCount: 1,
    },
    {
      name: "denied Codex web_search policy",
      config: { ...codexNativeConfig, tools: { ...codexNativeConfig.tools, deny: ["web_search"] } },
      model: openAIChatGptResponsesModel,
      expectedCount: 0,
    },
    {
      name: "denied OpenAI Responses web_search policy",
      config: { tools: { deny: ["web_search"] } },
      model: openAIResponsesModel,
      expectedCount: 0,
    },
    {
      name: "OpenAI provider without required auth",
      config: {
        tools: {
          web: {
            search: {
              enabled: true,
              openaiCodex: { enabled: true, mode: "cached" },
            },
          },
        },
      },
      model: openAIChatGptResponsesModel,
      expectedCount: 0,
    },
  ];

  it.each(nativeToolCases)("$name", ({ config, model, expectedCount }) => {
    expect(
      countProviderNativeToolsForPrecheck({
        config,
        model,
        nativeWebSearchPolicyContext: {},
      }),
    ).toBe(expectedCount);
  });
});

describe("resolveAttemptPromptModeAndSkillsPrompt", () => {
  it.each([
    ["no runtime allowlist", undefined, "full", "SKILLS"],
    ["empty runtime allowlist", [], "minimal", "SKILLS"],
    ["named runtime allowlist", ["read"], "minimal", undefined],
  ] as const)("%s", (_name, toolsAllow, expectedPromptMode, expectedSkillsPrompt) => {
    expect(
      resolveAttemptPromptModeAndSkillsPrompt({
        promptMode: "full",
        skillsPrompt: "SKILLS",
        toolsAllow,
      }),
    ).toEqual({
      promptMode: expectedPromptMode,
      ...(expectedSkillsPrompt ? { skillsPrompt: expectedSkillsPrompt } : {}),
    });
  });
});

describe("resolveAttemptToolPolicyMessageProvider", () => {
  it("prefers explicit tool-policy provider over transport channel", () => {
    expect(
      resolveAttemptToolPolicyMessageProvider({
        messageChannel: "discord",
        messageProvider: "discord-voice",
      }),
    ).toBe("discord-voice");
  });

  it("falls back to message channel when provider is omitted", () => {
    expect(resolveAttemptToolPolicyMessageProvider({ messageChannel: "discord" })).toBe("discord");
  });
});

describe("shouldRunLlmOutputHooksForAttempt", () => {
  it("skips llm_output after before_agent_run blocks before model submission", () => {
    expect(shouldRunLlmOutputHooksForAttempt({ promptErrorSource: "hook:before_agent_run" })).toBe(
      false,
    );
    expect(shouldRunLlmOutputHooksForAttempt({ promptErrorSource: "prompt" })).toBe(true);
    expect(shouldRunLlmOutputHooksForAttempt({ promptErrorSource: null })).toBe(true);
  });
});

describe("resolveUnknownToolGuardThreshold", () => {
  it("returns the default threshold when no loop-detection config is provided", () => {
    expect(resolveUnknownToolGuardThreshold(undefined)).toBe(10);
    expect(resolveUnknownToolGuardThreshold({})).toBe(10);
  });

  it("stays on even when tools.loopDetection.enabled is false", () => {
    // Unknown-tool guard is a model-safety circuit, separate from configurable
    // repeated-tool loop detection.
    expect(resolveUnknownToolGuardThreshold({ enabled: false })).toBe(10);
    expect(resolveUnknownToolGuardThreshold({ enabled: false, unknownToolThreshold: 3 })).toBe(3);
  });

  it("uses positive integer thresholds and floors fractions", () => {
    expect(resolveUnknownToolGuardThreshold({ enabled: true, unknownToolThreshold: 4 })).toBe(4);
    expect(resolveUnknownToolGuardThreshold({ unknownToolThreshold: 3.7 })).toBe(3);
  });

  it("falls back to the default threshold when the override is non-positive", () => {
    expect(resolveUnknownToolGuardThreshold({ unknownToolThreshold: 0 })).toBe(10);
    expect(resolveUnknownToolGuardThreshold({ unknownToolThreshold: -5 })).toBe(10);
    expect(resolveUnknownToolGuardThreshold({ unknownToolThreshold: Number.NaN })).toBe(10);
  });
});
