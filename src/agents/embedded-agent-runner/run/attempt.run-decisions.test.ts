import { describe, expect, it } from "vitest";
import {
  buildEmbeddedAttemptAgentEndHookEvent,
  buildEmbeddedAttemptLlmOutputHookEvent,
  resolveAttemptStreamAuthProfileId,
  resolveAttemptToolPolicyMessageProvider,
  resolveEmbeddedAttemptSessionWriteLockOptions,
  resolveUnknownToolGuardThreshold,
  selectHookRunnerForHook,
  shouldRunLlmOutputHooksForAttempt,
} from "./attempt.run-decisions.js";

describe("resolveEmbeddedAttemptSessionWriteLockOptions", () => {
  it("bounds post-prompt session lock max hold to compaction timeout instead of run timeout", () => {
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

describe("selectHookRunnerForHook", () => {
  const runner = (hooks: string[]) => ({
    hooks,
    hasHooks: (hookName: string) => hooks.includes(hookName),
  });

  it("uses the primary runner when it already has the requested hook", () => {
    const primary = runner(["before_agent_start", "llm_output"]);
    const current = runner(["llm_output"]);

    expect(selectHookRunnerForHook({ primary, current, hookName: "llm_output" })).toBe(primary);
  });

  it("falls back to the current runner when the primary runner only has prompt hooks", () => {
    const primary = runner(["before_agent_start"]);
    const current = runner(["before_agent_start", "llm_output", "agent_end"]);

    expect(selectHookRunnerForHook({ primary, current, hookName: "llm_output" })).toBe(current);
    expect(selectHookRunnerForHook({ primary, current, hookName: "agent_end" })).toBe(current);
  });

  it("returns undefined when neither runner has the requested hook", () => {
    expect(
      selectHookRunnerForHook({
        primary: runner(["before_agent_start"]),
        current: null,
        hookName: "llm_output",
      }),
    ).toBeUndefined();
  });
});

describe("buildEmbeddedAttemptLlmOutputHookEvent", () => {
  it("carries the original prompt and resolved runtime metadata", () => {
    const event = buildEmbeddedAttemptLlmOutputHookEvent({
      runId: "run-1",
      sessionId: "session-1",
      provider: "openai",
      modelId: "gpt-5.5",
      prompt: "original user prompt",
      contextWindowInfo: {
        tokens: 272000,
        referenceTokens: 400000,
        source: "modelsConfig",
      },
      runtimePlan: {
        observability: {
          resolvedRef: "openai/gpt-5.5",
          harnessId: "codex",
        },
      } as never,
      assistantTexts: ["final answer"],
      usage: {
        input: 10,
        output: 3,
        total: 13,
      },
    });

    expect(event).toMatchObject({
      runId: "run-1",
      sessionId: "session-1",
      provider: "openai",
      model: "gpt-5.5",
      prompt: "original user prompt",
      contextTokenBudget: 272000,
      contextWindowReferenceTokens: 400000,
      contextWindowSource: "modelsConfig",
      resolvedRef: "openai/gpt-5.5",
      harnessId: "codex",
      assistantTexts: ["final answer"],
      usage: {
        input: 10,
        output: 3,
        total: 13,
      },
    });
  });
});

describe("buildEmbeddedAttemptAgentEndHookEvent", () => {
  it("carries the prompt and assistant output needed by memory hooks", () => {
    const lastAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "final answer" }],
    };

    const event = buildEmbeddedAttemptAgentEndHookEvent({
      messages: [{ role: "user", content: "original user prompt" }, lastAssistant],
      prompt: "original user prompt",
      assistantTexts: ["final answer"],
      lastAssistant,
      success: true,
      durationMs: 123,
    });

    expect(event).toEqual({
      messages: [{ role: "user", content: "original user prompt" }, lastAssistant],
      prompt: "original user prompt",
      assistantTexts: ["final answer"],
      lastAssistant,
      success: true,
      durationMs: 123,
    });
  });
});

describe("resolveUnknownToolGuardThreshold", () => {
  it("returns the default threshold when no loop-detection config is provided", () => {
    expect(resolveUnknownToolGuardThreshold(undefined)).toBe(10);
    expect(resolveUnknownToolGuardThreshold({})).toBe(10);
  });

  it("stays on even when tools.loopDetection.enabled is false", () => {
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
