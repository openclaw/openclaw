import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedResolveModelAsync,
  mockedRunEmbeddedAttempt,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let state: OpenClawTestState;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;

function makeAssistantMessage(
  overrides: Partial<AssistantMessage> = {},
): NonNullable<EmbeddedRunAttemptResult["lastAssistant"]> {
  // Minimal assistant fixture lets tests override provider/model/usage without
  // recreating the full attempt result shape.
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: { input: 0, output: 0 } as AssistantMessage["usage"],
    stopReason: "end_turn" as AssistantMessage["stopReason"],
    timestamp: Date.now(),
    content: [],
    ...overrides,
  };
}

describe("runEmbeddedAgent usage reporting", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "usage-reporting" });
  });

  afterEach(async () => {
    await state?.cleanup();
  });

  it("keeps Anthropic multi-call billing usage separate from the final context snapshot", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Tool loop complete"],
        lastAssistant: makeAssistantMessage({
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
          } as unknown as AssistantMessage["usage"],
        }),
        currentAttemptAssistant: makeAssistantMessage({
          api: "anthropic-messages",
          provider: "minimax",
          model: "Minimax-M3",
          usage: {
            input: 67_932,
            output: 2_000,
            cacheRead: 18_944,
            totalTokens: 88_876,
          } as unknown as AssistantMessage["usage"],
        }),
        // Three model calls in one tool loop; this remains cumulative billing data.
        attemptUsage: { input: 110_337, output: 4_000, cacheRead: 40_000, total: 154_337 },
      }),
    );

    const result = await runEmbeddedAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "test-key",
      workspaceDir: state.workspaceDir,
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-anthropic-multi-call-usage",
    });

    expect(result.meta.agentMeta?.usage).toMatchObject({
      input: 110_337,
      output: 4_000,
      cacheRead: 40_000,
      total: 154_337,
    });
    expect(result.meta.agentMeta?.lastCallUsage).toMatchObject({
      input: 67_932,
      output: 2_000,
      cacheRead: 18_944,
    });
    expect(result.meta.agentMeta?.promptTokens).toBe(86_876);
  });

  it("reports the resolved model provider when OpenClaw marks the assistant message as the native runtime", async () => {
    mockedResolveModelAsync.mockResolvedValueOnce({
      logicalRef: { provider: "openrouter", model: "openai/gpt-5.4" },
      model: {
        id: "openai/gpt-5.4",
        provider: "openrouter",
        contextWindow: 200000,
        api: "openai-completions",
      },
      error: null,
      authStorage: {
        setRuntimeApiKey: vi.fn(),
      },
      modelRegistry: {},
    });
    const assistant = makeAssistantMessage({
      provider: "openclaw",
      model: "openclaw",
      content: [{ type: "text", text: "Response 1" }],
      usage: { input: 100, output: 50, total: 150 } as unknown as AssistantMessage["usage"],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Response 1"],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        attemptUsage: { input: 100, output: 50, total: 150 },
      }),
    );

    const result = await runEmbeddedAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "test-key",
      workspaceDir: state.workspaceDir,
      prompt: "hello",
      provider: "openrouter",
      model: "openai/gpt-5.4",
      timeoutMs: 30000,
      runId: "run-provider-attribution",
    });

    expect(result.meta.agentMeta?.provider).toBe("openrouter");
    expect(result.meta.agentMeta?.model).toBe("openai/gpt-5.4");
    expect(result.meta.executionTrace?.winnerProvider).toBe("openrouter");
    expect(result.meta.executionTrace?.winnerModel).toBe("openai/gpt-5.4");
  });
});
