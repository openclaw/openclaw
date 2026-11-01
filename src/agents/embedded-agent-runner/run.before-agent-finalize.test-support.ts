import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import {
  mockedGlobalHookRunner as hooks,
  mockedRunEmbeddedAttempt as attempt,
  resetSharedRunIntegrationHarnessMocks,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import {
  createSharedRunIntegrationSession,
  loadSharedRunIntegrationHarness,
} from "./run.shared-integration-harness.test-support.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

const REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";

let session: Awaited<ReturnType<typeof createSharedRunIntegrationSession>>;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;

function finalAnswer(text: string, overrides?: Partial<EmbeddedRunAttemptResult>) {
  const assistant = makeAssistantMessageFixture({
    stopReason: "stop",
    errorMessage: undefined,
    model: "gpt-5.5",
    content: [{ type: "text", text }],
  });
  return session.makeAttemptResult({
    assistantTexts: [text],
    lastAssistant: assistant,
    messagesSnapshot: [assistant],
    ...overrides,
  });
}

function runFinalize(runId: string) {
  return runEmbeddedAgent({ ...session.runParams, provider: "openai", model: "gpt-5.5", runId });
}

describe("runEmbeddedAgent before_agent_finalize", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    session = await createSharedRunIntegrationSession();
    useOpenAIPlatformAuthFixture();
    hooks.hasHooks.mockImplementation((name) => name === "before_agent_finalize");
  });

  afterEach(() => session?.cleanup());

  it("replaces an incomplete-turn continuation with a finalize revision", async () => {
    const reasoning = session.makeAttemptResult({
      assistantTexts: [],
      lastAssistant: {
        role: "assistant",
        stopReason: "end_turn",
        provider: "openai",
        model: "gpt-5.5",
        content: [
          {
            type: "thinking",
            thinking: "internal reasoning",
            thinkingSignature: JSON.stringify({ id: "rs_before_finalize", type: "reasoning" }),
          },
        ],
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    });
    attempt
      .mockResolvedValueOnce(reasoning)
      .mockResolvedValueOnce(
        finalAnswer("Visible draft.", {
          beforeAgentFinalizeRevisionReason: "Tighten the recovered answer.",
        }),
      )
      .mockResolvedValueOnce(finalAnswer("Revised recovered answer."));

    await runFinalize("run-before-finalize-after-incomplete-turn");

    expect(attempt).toHaveBeenCalledTimes(3);
    const prompts = attempt.mock.calls.map(([params]) => params.prompt);
    expect(prompts[1]).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
    expect(prompts[2]).toContain("Tighten the recovered answer.");
  });

  it("does not retry finalize revisions after a timed-out attempt", async () => {
    attempt.mockResolvedValueOnce(
      finalAnswer("Late answer.", {
        terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
        beforeAgentFinalizeRevisionReason: "Revise the late answer.",
        promptTimeoutOutcome: {
          message: "Request timed out.",
          replayInvalid: true,
          livenessState: "blocked",
          timeoutPhase: "provider",
          providerStarted: true,
        },
      }),
    );

    await runFinalize("run-before-finalize-timeout");

    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
