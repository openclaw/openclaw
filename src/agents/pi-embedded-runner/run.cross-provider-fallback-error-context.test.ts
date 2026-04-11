import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeModelFallbackCfg } from "../test-helpers/model-fallback-config-fixture.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  MockedFailoverError,
  mockedFormatAssistantErrorText,
  mockedGlobalHookRunner,
  mockedIsFailoverAssistantError,
  mockedIsRateLimitAssistantError,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

describe("runEmbeddedPiAgent cross-provider fallback error handling", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
  });

  it("uses the current attempt assistant for fallback errors instead of stale session history", async () => {
    mockedIsFailoverAssistantError.mockImplementation((...args: unknown[]) => {
      const assistant = args[0] as EmbeddedRunAttemptResult["currentAttemptAssistant"];
      return assistant?.provider === "deepseek";
    });
    mockedIsRateLimitAssistantError.mockImplementation((...args: unknown[]) => {
      const assistant = args[0] as EmbeddedRunAttemptResult["currentAttemptAssistant"];
      return assistant?.provider === "deepseek";
    });
    mockedFormatAssistantErrorText.mockImplementation((...args: unknown[]) => {
      const assistant = args[0] as EmbeddedRunAttemptResult["currentAttemptAssistant"];
      return `${assistant?.provider}/${assistant?.model}: ${assistant?.errorMessage}`;
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          stopReason: "error",
          errorMessage: "You have hit your ChatGPT usage limit (plus plan).",
          provider: "openai-codex",
          model: "gpt-5.4",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
        currentAttemptAssistant: {
          stopReason: "error",
          errorMessage: "429 deepseek rate limit",
          provider: "deepseek",
          model: "deepseek-chat",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["currentAttemptAssistant"],
      }),
    );

    const promise = runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-cross-provider-fallback-error-context",
      config: makeModelFallbackCfg({
        agents: {
          defaults: {
            model: {
              primary: "openai-codex/gpt-5.4",
              fallbacks: ["deepseek/deepseek-chat", "google/gemini-2.5-flash"],
            },
          },
        },
      }),
    });

    await expect(promise).rejects.toBeInstanceOf(MockedFailoverError);
    await expect(promise).rejects.toThrow("deepseek/deepseek-chat: 429 deepseek rate limit");
  });
});
