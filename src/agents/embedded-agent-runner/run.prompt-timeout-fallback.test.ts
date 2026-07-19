// Coverage for handing replay-safe plugin-harness prompt timeouts to model fallback.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeModelFallbackCfg } from "../test-helpers/model-fallback-config-fixture.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  MockedFailoverError,
  mockedClassifyFailoverReason,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
  useOpenAIPlatformAuthFixture,
  warmRunOverflowCompactionHarness,
} from "./run.overflow-compaction.harness.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

describe("runEmbeddedAgent prompt timeout fallback handoff", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
    await warmRunOverflowCompactionHarness(runEmbeddedAgent);
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    useOpenAIPlatformAuthFixture();
  });

  it("throws FailoverError for replay-safe harness-owned prompt timeouts when model fallbacks are configured", async () => {
    mockedClassifyFailoverReason.mockReturnValue("timeout");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        promptError: new Error("LLM request timed out."),
        promptErrorSource: "prompt",
      }),
    );

    const promise = runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-prompt-timeout-fallback",
      config: makeModelFallbackCfg({
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.4",
              fallbacks: ["anthropic/claude-opus-4-6"],
            },
          },
        },
      }),
    });

    await expect(promise).rejects.toBeInstanceOf(MockedFailoverError);
    await expect(promise).rejects.toThrow("LLM request timed out.");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("throws FailoverError for replay-safe provider aborts that only abort the prompt attempt", async () => {
    mockedClassifyFailoverReason.mockReturnValue("timeout");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        aborted: true,
        externalAbort: false,
        assistantTexts: [],
        promptError: Object.assign(new Error("This operation was aborted"), {
          name: "AbortError",
        }),
        promptErrorSource: "prompt",
      }),
    );

    const promise = runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "amazon-bedrock",
      model: "global.anthropic.claude-sonnet-4-6",
      runId: "run-bedrock-prompt-abort-fallback",
      config: makeModelFallbackCfg({
        agents: {
          defaults: {
            model: {
              primary: "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
              fallbacks: ["anthropic/claude-opus-4-6"],
            },
          },
        },
      }),
    });

    await expect(promise).rejects.toBeInstanceOf(MockedFailoverError);
    await expect(promise).rejects.toThrow("This operation was aborted");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("preserves provider aborts when no model fallback is configured", async () => {
    mockedClassifyFailoverReason.mockReturnValue("timeout");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        aborted: true,
        externalAbort: false,
        assistantTexts: [],
        promptError: Object.assign(new Error("This operation was aborted"), {
          name: "AbortError",
        }),
        promptErrorSource: "prompt",
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "amazon-bedrock",
      model: "global.anthropic.claude-sonnet-4-6",
      runId: "run-bedrock-prompt-abort-without-fallback",
      config: makeModelFallbackCfg({
        agents: {
          defaults: {
            model: {
              primary: "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
              fallbacks: [],
            },
          },
        },
      }),
    });

    expect(result.payloads).toEqual([
      {
        text: "⚠️ Agent couldn't generate a response. Please try again.",
        isError: true,
      },
    ]);
    expect(result.meta?.aborted).toBe(true);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("preserves visible output from a provider abort instead of handing off fallback", async () => {
    mockedClassifyFailoverReason.mockReturnValue("timeout");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        aborted: true,
        externalAbort: false,
        assistantTexts: ["partial answer"],
        promptError: Object.assign(new Error("This operation was aborted"), {
          name: "AbortError",
        }),
        promptErrorSource: "prompt",
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "amazon-bedrock",
      model: "global.anthropic.claude-sonnet-4-6",
      runId: "run-bedrock-prompt-abort-visible-output",
      config: makeModelFallbackCfg({
        agents: {
          defaults: {
            model: {
              primary: "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
              fallbacks: ["anthropic/claude-opus-4-6"],
            },
          },
        },
      }),
    });

    expect(result.payloads).toBeUndefined();
    expect(result.meta?.finalAssistantVisibleText).toBe("partial answer");
    expect(result.meta?.aborted).toBe(true);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it.each(["NO_REPLY", "HEARTBEAT_OK"])(
    "hands %s-only provider aborts to fallback",
    async (assistantText) => {
      mockedClassifyFailoverReason.mockReturnValue("timeout");
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(
        makeAttemptResult({
          aborted: true,
          externalAbort: false,
          assistantTexts: [assistantText],
          promptError: Object.assign(new Error("This operation was aborted"), {
            name: "AbortError",
          }),
          promptErrorSource: "prompt",
        }),
      );

      const promise = runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "amazon-bedrock",
        model: "global.anthropic.claude-sonnet-4-6",
        runId: "run-bedrock-prompt-abort-silent-output",
        config: makeModelFallbackCfg({
          agents: {
            defaults: {
              model: {
                primary: "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
                fallbacks: ["anthropic/claude-opus-4-6"],
              },
            },
          },
        }),
      });

      await expect(promise).rejects.toBeInstanceOf(MockedFailoverError);
      await expect(promise).rejects.toThrow("This operation was aborted");
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves caller aborts that arrive before prompt-abort recovery", async () => {
    const controller = new AbortController();
    const abortError = Object.assign(new Error("caller cancelled"), {
      name: "AbortError",
    });
    mockedClassifyFailoverReason.mockReturnValue("timeout");
    mockedRunEmbeddedAttempt.mockImplementationOnce(async () => {
      controller.abort(abortError);
      return makeAttemptResult({
        aborted: true,
        externalAbort: false,
        assistantTexts: [],
        promptError: abortError,
        promptErrorSource: "prompt",
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "amazon-bedrock",
      model: "global.anthropic.claude-sonnet-4-6",
      runId: "run-caller-abort-before-prompt-recovery",
      abortSignal: controller.signal,
      config: makeModelFallbackCfg({
        agents: {
          defaults: {
            model: {
              primary: "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
              fallbacks: ["anthropic/claude-opus-4-6"],
            },
          },
        },
      }),
    });

    expect(result.meta?.aborted).toBe(true);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("surfaces replay-invalid prompt timeouts instead of handing them to model fallback", async () => {
    mockedClassifyFailoverReason.mockReturnValue("timeout");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        promptError: new Error("LLM request timed out."),
        promptErrorSource: "prompt",
        promptTimeoutOutcome: {
          message: "Harness abandoned the timed-out turn after provider activity.",
          replayInvalid: true,
          livenessState: "abandoned",
        },
      }),
    );

    let thrown: unknown;
    try {
      await runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "openai",
        model: "gpt-5.4",
        runId: "run-prompt-timeout-replay-invalid",
        config: makeModelFallbackCfg({
          agents: {
            defaults: {
              model: {
                primary: "openai/gpt-5.4",
                fallbacks: ["anthropic/claude-opus-4-6"],
              },
            },
          },
        }),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(MockedFailoverError);
    expect(String((thrown as Error | undefined)?.message)).toContain("LLM request timed out.");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });
});
