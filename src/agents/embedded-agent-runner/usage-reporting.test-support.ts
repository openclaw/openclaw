import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAgentAssistantMessage as makeAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedResolveModelAsync,
  mockedRunEmbeddedAttempt,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";

let state: OpenClawTestState;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;

function runUsage(
  runId: string,
  attempt: Parameters<typeof makeAttemptResult>[0],
  overrides: Partial<Parameters<typeof runEmbeddedAgent>[0]> = {},
) {
  mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult(attempt));
  return runEmbeddedAgent({
    sessionId: "test-session",
    sessionKey: "test-key",
    sessionFile: "test-key",
    workspaceDir: state.workspaceDir,
    prompt: "hello",
    timeoutMs: 30000,
    runId,
    ...overrides,
  });
}

describe("runEmbeddedAgent usage reporting", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "usage-reporting" });
    const { setRuntimeConfigSnapshot } = await import("../../config/runtime-snapshot.js");
    setRuntimeConfigSnapshot({});
  });

  afterEach(() => state?.cleanup());

  it("keeps Anthropic multi-call billing usage separate from the final context snapshot", async () => {
    const result = await runUsage("run-anthropic-multi-call-usage", {
      assistantTexts: ["Tool loop complete"],
      lastAssistant: makeAssistantMessage({ content: [] }),
      currentAttemptAssistant: makeAssistantMessage({
        content: [],
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
    });
    expect(result.meta.agentMeta).toMatchObject({
      usage: { input: 110_337, output: 4_000, cacheRead: 40_000, total: 154_337 },
      lastCallUsage: { input: 67_932, output: 2_000, cacheRead: 18_944 },
      promptTokens: 86_876,
    });
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
      authStorage: { setRuntimeApiKey: vi.fn() },
      modelRegistry: {},
    });
    const assistant = makeAssistantMessage({
      provider: "openclaw",
      model: "openclaw",
      content: [{ type: "text", text: "Response 1" }],
      usage: { input: 100, output: 50, total: 150 } as unknown as AssistantMessage["usage"],
    });
    const result = await runUsage(
      "run-provider-attribution",
      {
        assistantTexts: ["Response 1"],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        attemptUsage: { input: 100, output: 50, total: 150 },
      },
      {
        provider: "openrouter",
        model: "openai/gpt-5.4",
      },
    );

    expect(result.meta).toMatchObject({
      agentMeta: { provider: "openrouter", model: "openai/gpt-5.4" },
      executionTrace: { winnerProvider: "openrouter", winnerModel: "openai/gpt-5.4" },
    });
  });
});
