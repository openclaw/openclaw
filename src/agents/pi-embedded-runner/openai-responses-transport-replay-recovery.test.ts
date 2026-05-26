import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedLog,
  mockedResolveModelAsync,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

function configureOpenAIResponsesModel(): void {
  mockedResolveModelAsync.mockResolvedValue({
    model: {
      id: "gpt-5.4",
      provider: "openai",
      contextWindow: 200000,
      api: "openai-responses",
    },
    error: null,
    authStorage: {
      setRuntimeApiKey: vi.fn(),
    },
    modelRegistry: {},
  });
}

function configureOpenAICompletionsModel(): void {
  mockedResolveModelAsync.mockResolvedValue({
    model: {
      id: "gpt-5.4",
      provider: "openai",
      contextWindow: 200000,
      api: "openai-completions",
    },
    error: null,
    authStorage: {
      setRuntimeApiKey: vi.fn(),
    },
    modelRegistry: {},
  });
}

function corruptedPromptAttempt(
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  return makeAttemptResult({
    promptError: new Error(
      "400 thinking_signature_invalid: encrypted content could not be verified",
    ),
    promptErrorSource: "prompt",
    assistantTexts: [],
    ...overrides,
  });
}

function successAttempt(): EmbeddedRunAttemptResult {
  return makeAttemptResult({
    promptError: null,
    assistantTexts: ["Done."],
  });
}

function corruptedAssistantAttempt(): EmbeddedRunAttemptResult {
  const assistant = {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: "invalid_encrypted_content",
    timestamp: 1,
    content: [],
  } as EmbeddedRunAttemptResult["lastAssistant"];

  return makeAttemptResult({
    promptError: null,
    assistantTexts: [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
  });
}

function requireAttemptParams(index: number): Record<string, unknown> {
  const call = mockedRunEmbeddedAttempt.mock.calls[index];
  if (!call?.[0] || typeof call[0] !== "object") {
    throw new Error(`expected attempt call ${index}`);
  }
  return call[0] as Record<string, unknown>;
}

function loggedWarns(): string {
  return mockedLog.warn.mock.calls.map((call) => String(call[0])).join("\n");
}

const unsafeReplayCases: Array<[string, Partial<EmbeddedRunAttemptResult>]> = [
  [
    "message tool delivery",
    {
      didSendViaMessagingTool: true,
      messagingToolSentTexts: ["already sent"],
    },
  ],
  ["mutating tool", { toolMetas: [{ toolName: "write" }] }],
  ["cron add", { successfulCronAdds: 1 }],
  [
    "session spawn",
    {
      acceptedSessionSpawns: [{ runId: "child-run", childSessionKey: "child-session" }],
    },
  ],
];

describe("runEmbeddedPiAgent OpenAI Responses continuation recovery", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    configureOpenAIResponsesModel();
  });

  it("retries a replay-safe continuation corruption once with replay state dropped", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(corruptedPromptAttempt())
      .mockResolvedValueOnce(successAttempt());

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "responses-continuation-recovery",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const retryParams = requireAttemptParams(1);
    expect(retryParams.suppressNextUserMessagePersistence).toBe(true);
    expect(retryParams.dropOpenAIResponsesReplayState).toBe(true);
    expect(String(retryParams.prompt)).toContain("provider continuation state was invalid");
    expect(retryParams.prompt).not.toBe(overflowBaseRunParams.prompt);
    expect(result.meta.replayInvalid).not.toBe(true);
    expect(result.meta.error).toBeUndefined();
    expect(loggedWarns()).toContain("responses_continuation_recovery_succeeded");
  });

  it.each(unsafeReplayCases)(
    "does not retry continuation corruption after %s",
    async (_label, overrides) => {
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(corruptedPromptAttempt(overrides));

      const result = await runEmbeddedPiAgent({
        ...overflowBaseRunParams,
        provider: "openai",
        model: "gpt-5.4",
        runId: "responses-continuation-unsafe",
      });

      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
      expect(result.meta.livenessState).toBe("blocked");
      expect(result.meta.replayInvalid).toBe(true);
      expect(result.meta.error?.kind).toBe("responses_continuation_corruption");
      expect(loggedWarns()).toContain("responses_continuation_recovery_blocked");
    },
  );

  it("preserves message-tool delivery evidence when blocking unsafe recovery", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      corruptedPromptAttempt({
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["already sent"],
        messagingToolSentMediaUrls: ["https://example.test/image.png"],
        messagingToolSentTargets: [{ tool: "message", provider: "test", to: "test-channel" }],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "responses-continuation-message-tool-unsafe",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.meta.livenessState).toBe("blocked");
    expect(result.meta.replayInvalid).toBe(true);
    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTexts).toEqual(["already sent"]);
    expect(result.messagingToolSentMediaUrls).toEqual(["https://example.test/image.png"]);
    expect(result.messagingToolSentTargets).toHaveLength(1);
  });

  it("preserves cron and session-spawn evidence when blocking unsafe recovery", async () => {
    const acceptedSessionSpawns = [{ runId: "child-run", childSessionKey: "child-session" }];
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      corruptedPromptAttempt({
        successfulCronAdds: 1,
        acceptedSessionSpawns,
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "responses-continuation-cron-session-unsafe",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.meta.livenessState).toBe("blocked");
    expect(result.meta.replayInvalid).toBe(true);
    expect(result.successfulCronAdds).toBe(1);
    expect(result.acceptedSessionSpawns).toEqual(acceptedSessionSpawns);
  });

  it("also recovers continuation corruption surfaced as an assistant error", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(corruptedAssistantAttempt())
      .mockResolvedValueOnce(successAttempt());

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "responses-continuation-assistant-error",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(requireAttemptParams(1).dropOpenAIResponsesReplayState).toBe(true);
    expect(loggedWarns()).toContain("source=assistantError");
  });

  it("does not use Responses recovery for non-Responses OpenAI APIs", async () => {
    configureOpenAICompletionsModel();
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(corruptedPromptAttempt());

    await expect(
      runEmbeddedPiAgent({
        ...overflowBaseRunParams,
        provider: "openai",
        model: "gpt-5.4",
        runId: "responses-continuation-non-responses-api",
      }),
    ).rejects.toThrow("thinking_signature_invalid");

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(loggedWarns()).not.toContain("responses_continuation_recovery_retry");
  });

  it("blocks after the one-shot recovery retry also sees stale continuation state", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(corruptedPromptAttempt()).mockResolvedValueOnce(
      corruptedPromptAttempt({
        promptError: new Error("Item with id 'rs_retry' not found"),
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "responses-continuation-retry-fails",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.meta.livenessState).toBe("blocked");
    expect(result.meta.replayInvalid).toBe(true);
    expect(result.meta.error?.kind).toBe("responses_continuation_corruption");
    expect(loggedWarns()).toContain("responses_continuation_recovery_blocked");
  });
});
