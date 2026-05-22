import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { makeModelFallbackCfg } from "../test-helpers/model-fallback-config-fixture.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  MockedFailoverError,
  mockedClassifyFailoverReason,
  mockedFormatAssistantErrorText,
  mockedGlobalHookRunner,
  mockedIsFailoverAssistantError,
  mockedResolveModelAsync,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

describe("runEmbeddedPiAgent Codex server_error fallback handoff", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
  });

  it("throws FailoverError for Codex server_error when model fallbacks are configured", async () => {
    const rawCodexError =
      'Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request."},"sequence_number":2}';

    mockedClassifyFailoverReason.mockReturnValue("timeout");
    mockedIsFailoverAssistantError.mockReturnValue(true);
    mockedFormatAssistantErrorText.mockReturnValue(
      "LLM error server_error: An error occurred while processing your request.",
    );
    const currentAttemptAssistant = makeAssistantMessageFixture({
      stopReason: "error",
      errorMessage: rawCodexError,
      provider: "openai-codex",
      model: "gpt-5.4",
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: currentAttemptAssistant,
        currentAttemptAssistant,
      }),
    );

    const promise = runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-codex-server-error-fallback",
      config: makeModelFallbackCfg({
        agents: {
          defaults: {
            model: {
              primary: "openai-codex/gpt-5.4",
              fallbacks: ["anthropic/claude-opus-4-6"],
            },
          },
        },
      }),
    });

    await expect(promise).rejects.toBeInstanceOf(MockedFailoverError);
    await expect(promise).rejects.toThrow(
      "LLM error server_error: An error occurred while processing your request.",
    );
  });

  it("throws FailoverError for Codex responses turns that spend output tokens without visible assistant output", async () => {
    mockedResolveModelAsync.mockResolvedValue({
      model: {
        id: "gpt-5.5",
        provider: "openai-codex",
        contextWindow: 200000,
        api: "openai-codex-responses",
      },
      error: null,
      authStorage: {
        setRuntimeApiKey: vi.fn(),
      },
      modelRegistry: {},
    });
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: undefined,
        currentAttemptAssistant: undefined,
        messagesSnapshot: [
          {
            role: "user",
            content: "u there partner ??",
          } as EmbeddedRunAttemptResult["messagesSnapshot"][number],
        ],
        attemptUsage: {
          input: 24794,
          output: 111,
          cacheRead: 4608,
          total: 29513,
        },
      }),
    );

    const promise = runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "openai-codex",
      model: "gpt-5.5",
      runId: "run-codex-responses-empty-visible-output-fallback",
      config: makeModelFallbackCfg({
        agents: {
          defaults: {
            model: {
              primary: "openai-codex/gpt-5.5",
              fallbacks: ["anthropic/claude-opus-4-6"],
            },
          },
        },
      }),
    });

    await expect(promise).rejects.toBeInstanceOf(MockedFailoverError);
    await expect(promise).rejects.toThrow(
      "openai-codex-responses returned no visible assistant output despite nonzero output tokens.",
    );
  });
});
