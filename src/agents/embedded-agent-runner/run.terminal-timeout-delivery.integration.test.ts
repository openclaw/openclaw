import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { settleReplyDispatcher } from "../../auto-reply/dispatch-dispatcher.js";
import type { ReplyDispatchRuntimeInfo } from "../../auto-reply/reply/reply-dispatcher.types.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { classifyEmbeddedAgentRunResultForModelFallback } from "./result-fallback-classifier.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedBuildEmbeddedRunPayloads,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
  resetSharedRunIntegrationHarnessMocks,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./run/terminal-outcome.js";
import { resolveEmbeddedRunTerminalTimeout } from "./run/terminal-timeout.js";

let state: OpenClawTestState;
const GENERIC_TIMEOUT = "LLM request timed out.";
const AUTHORITATIVE_TIMEOUT =
  "Provider timed out after the request started. Retry the turn, or increase its configured timeout.";
const TOOL_MEDIA_URL = "https://example.test/tool-output.png";
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;
let buildEmbeddedRunPayloads: typeof import("./run/payloads.js").buildEmbeddedRunPayloads;
let createReplyDispatcher: typeof import("../../auto-reply/reply/reply-dispatcher.js").createReplyDispatcher;

beforeAll(async () => {
  runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  ({ buildEmbeddedRunPayloads } =
    await vi.importActual<typeof import("./run/payloads.js")>("./run/payloads.js"));
  ({ createReplyDispatcher } = await import("../../auto-reply/reply/reply-dispatcher.js"));
  resetSharedRunIntegrationHarnessMocks();
  const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
  state = await createOpenClawTestState({ label: "terminal-timeout-delivery" });
});
afterAll(async () => {
  await state?.cleanup();
});

it("delivers one authoritative timeout while preserving an independent same-text error and tool media", async () => {
  const assistant = makeAssistantMessageFixture({
    stopReason: "aborted",
    errorMessage: GENERIC_TIMEOUT,
    content: [],
  });
  const independentError: ReplyPayload = { text: GENERIC_TIMEOUT, isError: true };
  mockedBuildEmbeddedRunPayloads.mockImplementation((params) => [
    ...buildEmbeddedRunPayloads(params),
    independentError,
  ]);
  mockedRunEmbeddedAttempt.mockResolvedValueOnce(
    makeAttemptResult({
      assistantTexts: [],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      currentAttemptCompletedAssistant: assistant,
      terminal: { kind: "timeout", phase: "prompt", source: "idle", aborted: true },
      promptTimeoutOutcome: {
        message: AUTHORITATIVE_TIMEOUT,
        replayInvalid: false,
        livenessState: "abandoned",
        timeoutPhase: "provider",
        providerStarted: true,
      },
      toolMediaUrls: [TOOL_MEDIA_URL],
    }),
  );
  useOpenAIPlatformAuthFixture();
  const result = await runEmbeddedAgent({
    ...createOverflowRunParams(state),
    provider: "openai",
    model: "gpt-5.4",
    runId: "provider-idle-timeout-single-final-delivery",
  });
  expect(result.meta).toMatchObject({
    error: { kind: "incomplete_turn", message: AUTHORITATIVE_TIMEOUT, fallbackSafe: false },
    replayInvalid: false,
    livenessState: "abandoned",
    timeoutPhase: "provider",
    providerStarted: true,
    modelFallbackStopReason: "agent_run_terminal_timeout",
  });
  expect(
    classifyEmbeddedAgentRunResultForModelFallback({
      provider: "openai",
      model: "gpt-5.4",
      result,
    }),
  ).toBeNull();
  const physicalSends: Array<{ payload: ReplyPayload; info: ReplyDispatchRuntimeInfo }> = [];
  const dispatcher = createReplyDispatcher({
    deliver: async (payload, info) => {
      physicalSends.push({ payload, info });
      return { visibleReplySent: true, messageId: `mock-send-${physicalSends.length}` };
    },
  });
  for (const payload of result.payloads ?? []) {
    expect(dispatcher.sendFinalReply(payload)).toBe(true);
  }
  await settleReplyDispatcher({ dispatcher });
  expect(physicalSends).toEqual([
    {
      payload: expect.objectContaining(independentError),
      info: expect.objectContaining({ kind: "final" }),
    },
    {
      payload: expect.objectContaining({ mediaUrl: TOOL_MEDIA_URL, mediaUrls: [TOOL_MEDIA_URL] }),
      info: expect.objectContaining({ kind: "final" }),
    },
    {
      payload: { text: AUTHORITATIVE_TIMEOUT, isError: true },
      info: expect.objectContaining({ kind: "final" }),
    },
  ]);
  expect(dispatcher.getFailedCounts()).toEqual({ tool: 0, block: 0, final: 0 });
});

it("does not replace a successfully recovered final assistant after a prompt-timeout race", () => {
  const attempt = makeAttemptResult({
    terminal: { kind: "timeout", phase: "prompt", source: "runtime", aborted: true },
  });
  const payloads = [{ text: "Completed answer after the timeout race." }];
  const setTerminalLifecycleMeta = vi.fn();
  const result = resolveEmbeddedRunTerminalTimeout({
    terminalPrepared: {
      timedOutDuringPrompt: true,
      hasSuccessfulFinalAssistantAfterPromptTimeout: true,
      hasPartialAssistantTextAfterPromptTimeout: false,
      replyDeliveryState: "missing",
      reportedModelRef: { provider: "openai", model: "gpt-5.4" },
      finalAssistantVisibleText: undefined,
      finalAssistantRawText: undefined,
      recoveredFinalAssistantPayloadsAfterPromptTimeout: undefined,
      payloads,
      payloadsWithToolMedia: payloads,
      agentMeta: { sessionId: "session-1", provider: "openai", model: "gpt-5.4" },
      attemptToolSummary: undefined,
      failureSignal: undefined,
      terminalToolFailure: undefined,
    },
    attempt,
    terminalState: resolveEmbeddedRunAttemptTerminalState({
      attempt,
      assistant: attempt.lastAssistant,
    }),
    resolveReplayInvalid: () => false,
    setTerminalLifecycleMeta,
    startedAtMs: Date.now(),
  });
  expect(result).toBeUndefined();
  expect(setTerminalLifecycleMeta).not.toHaveBeenCalled();
});
