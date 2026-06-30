// Coverage for small run-attempt decision helpers.
import { describe, expect, it } from "vitest";
import {
  countProviderNativeToolsForPrecheck,
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
  const openAIResponsesModel = {
    api: "openai-responses",
    id: "gpt-5.5",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
  };

  it.each([
    ["eligible OpenAI Responses", {}, openAIResponsesModel, 1],
    [
      "disabled web search",
      { tools: { web: { search: { enabled: false } } } },
      openAIResponsesModel,
      0,
    ],
    ["proxied base URL", {}, { ...openAIResponsesModel, baseUrl: "https://proxy.test/v1" }, 0],
    ["denied web_search policy", { tools: { deny: ["web_search"] } }, openAIResponsesModel, 0],
    [
      "different search provider",
      { tools: { web: { search: { provider: "brave" } } } },
      openAIResponsesModel,
      0,
    ],
  ])("%s", (_name, config, model, expectedCount) => {
    expect(
      countProviderNativeToolsForPrecheck({
        config,
        model,
        nativeWebSearchPolicyContext: {},
      }),
    ).toBe(expectedCount);
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
