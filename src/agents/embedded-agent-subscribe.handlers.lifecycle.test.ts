import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createHookRunner } from "../plugins/hooks.js";
import { createMockPluginRegistry, TEST_PLUGIN_AGENT_CTX } from "../plugins/hooks.test-fixtures.js";
import { handleAgentEnd, handleAgentStart } from "./embedded-agent-subscribe.handlers.lifecycle.js";
import { createContext } from "./embedded-agent-subscribe.handlers.lifecycle.test-helpers.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import { createReplyDelivery } from "./embedded-agent-subscribe.reply-delivery.js";

const { emitAgentEventMock } = vi.hoisted(() => ({ emitAgentEventMock: vi.fn() }));
const identity = { sessionId: "session-1", agentId: "main" };
const BEFORE_AGENT_FINALIZE_EVENT = {
  runId: "run-1",
  sessionId: "session-1",
  stopHookActive: false,
};

vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: emitAgentEventMock,
  getAgentEventLifecycleGeneration: () => "test-generation",
  isAgentEventLifecycleGenerationCurrent: (generation: string) => generation === "test-generation",
  registerAgentEventLifecycleRotationHandler: vi.fn(),
}));

function errorContext(errorMessage: string, assistant: Record<string, unknown> = {}) {
  const onAgentEvent = vi.fn();
  const ctx = createContext(
    { role: "assistant", stopReason: "error", content: [], errorMessage, ...assistant },
    { onAgentEvent },
  );
  ctx.state.livenessState = "working";
  return { ctx, onAgentEvent };
}
function warnMeta(ctx: EmbeddedAgentSubscribeContext): Record<string, unknown> {
  return vi.mocked(ctx.log.warn).mock.calls[0]?.[1] ?? {};
}
function expectEvent(onAgentEvent: ReturnType<typeof vi.fn>, data: Record<string, unknown>) {
  expect(onAgentEvent).toHaveBeenCalledWith({ stream: "lifecycle", data });
}

describe("embedded lifecycle", () => {
  it("keeps identity and the same observed start time on the bus and callback", () => {
    emitAgentEventMock.mockClear();
    const onAgentEvent = vi.fn();
    const ctx = createContext(undefined, { onAgentEvent });
    Object.assign(ctx.params, identity);
    handleAgentStart(ctx);
    expect(emitAgentEventMock).toHaveBeenCalledWith({
      runId: "run-1",
      sessionKey: "agent:main:main",
      ...identity,
      stream: "lifecycle",
      data: { phase: "start", startedAt: expect.any(Number) },
    });
    expect(onAgentEvent).toHaveBeenCalledExactlyOnceWith({
      stream: "lifecycle",
      data: emitAgentEventMock.mock.calls[0]?.[0].data,
    });
  });
  it("keeps the execution lifecycle generation on terminal events", async () => {
    emitAgentEventMock.mockClear();
    const ctx = createContext(undefined);
    Object.assign(ctx.params, {
      lifecycleGeneration: "pre-restart-generation",
      ...identity,
    });
    await handleAgentEnd(ctx);
    expect(emitAgentEventMock).toHaveBeenCalledWith({
      runId: "run-1",
      sessionKey: "agent:main:main",
      ...identity,
      lifecycleGeneration: "pre-restart-generation",
      stream: "lifecycle",
      data: expect.objectContaining({ phase: "end" }),
    });
  });

  it("omits raw HTML auth bodies from console diagnostics", async () => {
    const { ctx } = errorContext("403 <!DOCTYPE html><html><body>Access denied</body></html>", {
      provider: "openai",
      model: "test-model",
    });
    await handleAgentEnd(ctx);
    expect(warnMeta(ctx)).toMatchObject({
      error:
        "Authentication failed at the provider. Re-authenticate and verify your provider credentials and account access.",
      providerRuntimeFailureKind: "auth_html",
    });
    expect(warnMeta(ctx).consoleMessage).not.toContain("rawError=");
    expect(warnMeta(ctx).consoleMessage).not.toContain("<html>");
  });

  it.each([
    {
      raw: "x-api-key: sk-abcdefghijklmnopqrstuvwxyz123456",
      secret: "sk-abcdefghijklmnopqrstuvwxyz123456",
      error: "LLM request failed.",
      observation: { providerRuntimeFailureKind: "unclassified" },
      preview: "x-api-key: ***",
    },
    {
      raw: '{"type":"error","error":{"type":"server_error","message":"Upstream failed x-api-key: SECRET_CANARY_69737"}}',
      secret: "SECRET_CANARY_69737",
      error:
        "⚠️ LLM request failed (provider internal error). This is usually temporary — try again shortly.",
      observation: {
        providerErrorType: "server_error",
        providerErrorMessagePreview: "Upstream failed x-api-key: ***",
      },
    },
  ])(
    "redacts provider diagnostics before publishing: $secret",
    async ({ raw, secret, error, observation, preview }) => {
      const { ctx, onAgentEvent } = errorContext(raw);
      await handleAgentEnd(ctx);
      expect(warnMeta(ctx).error).toBe(error);
      if (preview) {
        expect(warnMeta(ctx).rawErrorPreview).toBe(preview);
      }
      expect(JSON.stringify(onAgentEvent.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(onAgentEvent.mock.calls)).not.toContain("rawError");
      expectEvent(onAgentEvent, {
        phase: "error",
        error,
        errorObservation: expect.objectContaining(observation),
        livenessState: "blocked",
      });
    },
  );
  it("sanitizes model and provider console control characters", async () => {
    const { ctx } = errorContext("connection refused", {
      provider: "anthropic\u009b\u001b]8;;https://evil.test\u0007",
      model: "claude\tsonnet\n4",
    });
    await handleAgentEnd(ctx);
    expect(warnMeta(ctx).consoleMessage).toBe(
      "embedded run agent end: runId=run-1 isError=true model=claude sonnet 4 provider=anthropic]8;;https://evil.test error=LLM request failed: connection refused by the provider endpoint. rawError=connection refused",
    );
    for (const control of ["\n", "\r", "\t", "\u001b", "\u009b"]) {
      expect(warnMeta(ctx).consoleMessage).not.toContain(control);
    }
  });

  it("overrides embedded abort terminals with the restart stop reason", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(undefined, {
      onAgentEvent,
      resolveTerminalStopReason: () => "restart",
    });
    Object.assign(ctx.state, { terminalStopReason: "aborted", terminalAborted: true });
    await handleAgentEnd(ctx);
    expectEvent(onAgentEvent, { phase: "end", stopReason: "restart", aborted: true });
  });
  it.each([
    {
      toolName: "edit",
      error:
        'Validation failed for tool "edit":\n - edits: required\nReceived arguments:\n{"path":"secret.txt"}',
      validationErrorSummary: "edit tool validation failed: invalid arguments",
    },
    { toolName: "browser", error: "tab not found: secret-token" },
  ])("exposes only a validation summary for aborted $toolName failures", async (lastToolError) => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(undefined, { onAgentEvent });
    Object.assign(ctx.state, { terminalAborted: true, lastToolError });
    await handleAgentEnd(ctx);
    expectEvent(onAgentEvent, {
      phase: "end",
      aborted: true,
      ...(lastToolError.validationErrorSummary
        ? { toolErrorSummary: lastToolError.validationErrorSummary }
        : {}),
    });
    expect(JSON.stringify(onAgentEvent.mock.calls)).not.toContain(
      lastToolError.toolName === "edit" ? "Received arguments" : "secret-token",
    );
  });
  it.each<{
    name: string;
    stopReason?: string;
    content?: unknown[];
    state: Partial<EmbeddedAgentSubscribeContext["state"]>;
    params?: Partial<EmbeddedAgentSubscribeContext["params"]>;
    expected: Record<string, unknown>;
  }>([
    {
      name: "surfaces replay-invalid paused lifecycle end state when present",
      state: {
        replayState: { replayInvalid: true, hadPotentialSideEffects: false },
        livenessState: "paused",
      },
      expected: { livenessState: "paused", replayInvalid: true },
    },
    {
      name: "marks tool-use terminal with pre-tool text as abandoned (#76477)",
      stopReason: "toolUse",
      content: [
        { type: "text", text: "Initial analysis..." },
        { type: "tool_use", id: "tool_1", name: "read", input: { path: "src/index.ts" } },
      ],
      state: { assistantTexts: ["Initial analysis..."] },
      expected: { livenessState: "abandoned", replayInvalid: true },
    },
    {
      name: "keeps token-limited text replayable when it was never streamed",
      stopReason: "length",
      content: [{ type: "text", text: "Partial answer" }],
      state: { assistantTexts: [] },
      expected: { livenessState: "working" },
    },
    {
      name: "marks a token-limited turn with nothing to deliver as abandoned",
      stopReason: "length",
      state: { assistantTexts: [] },
      expected: { livenessState: "abandoned", replayInvalid: true },
    },
    {
      name: "preserves token-limited deferred media before terminal delivery",
      stopReason: "length",
      state: { deferredBlockReplies: [{ mediaUrls: ["/tmp/render.png"] }] },
      expected: { livenessState: "working" },
    },
    {
      name: "preserves token-limited message-tool-only delivery before runner finalization",
      stopReason: "length",
      state: { messageToolOnlySourceReplyDelivered: true },
      params: { sourceReplyDeliveryMode: "message_tool_only" },
      expected: { livenessState: "working" },
    },
    {
      name: "keeps accumulated deterministic side effects from being marked abandoned",
      state: {
        replayState: { replayInvalid: true, hadPotentialSideEffects: false },
        assistantTexts: [],
        hadDeterministicSideEffect: true,
      },
      expected: { livenessState: "working", replayInvalid: true },
    },
    {
      name: "keeps accepted session spawns from being marked abandoned",
      state: {
        replayState: { replayInvalid: true, hadPotentialSideEffects: false },
        assistantTexts: [],
        acceptedSessionSpawns: [
          { runId: "run-child", childSessionKey: "agent:claude:subagent:child" },
        ],
      },
      expected: { livenessState: "working", replayInvalid: true },
    },
  ])("$name", async ({ stopReason, content = [], state, params, expected }) => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(stopReason ? { role: "assistant", stopReason, content } : undefined, {
      onAgentEvent,
    });
    Object.assign(ctx.state, { livenessState: "working" }, state);
    Object.assign(ctx.params, params);

    await handleAgentEnd(ctx);

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: { phase: "end", ...(stopReason ? { stopReason } : {}), ...expected },
    });
  });

  it("delivers orphaned media before the terminal event and consumes it", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(undefined, { onAgentEvent });
    Object.assign(ctx.state, {
      pendingToolMediaUrls: ["/tmp/reply.opus"],
      pendingToolAudioAsVoice: true,
    });
    vi.mocked(ctx.emitBlockReply).mockImplementation(
      createReplyDelivery({ params: ctx.params, state: ctx.state, log: ctx.log }).emitBlockReply,
    );
    await handleAgentEnd(ctx);
    expect(ctx.emitBlockReply).toHaveBeenCalledExactlyOnceWith({
      mediaUrls: ["/tmp/reply.opus"],
      audioAsVoice: true,
    });
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
    expect(ctx.state.pendingToolAudioAsVoice).toBe(false);
    expect(onAgentEvent.mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(ctx.emitBlockReply).mock.invocationCallOrder[0] ?? Infinity,
    );
  });
  it("preserves orphaned media without a delivery callback", async () => {
    const ctx = createContext(undefined, { onBlockReply: undefined });
    Object.assign(ctx.state, {
      pendingToolMediaUrls: ["/tmp/reply.opus"],
      pendingToolAudioAsVoice: true,
    });
    await handleAgentEnd(ctx);
    expect(ctx.emitBlockReply).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual(["/tmp/reply.opus"]);
    expect(ctx.state.pendingToolAudioAsVoice).toBe(true);
  });

  it.each(["block", "channel"] as const)(
    "resolves compaction before %s flush and delays terminal emission until delivery",
    async (kind) => {
      const { promise, resolve } = createDeferred();
      const { ctx, onAgentEvent } = errorContext("connection refused");
      if (kind === "block") {
        vi.mocked(ctx.flushBlockReplyBuffer).mockReturnValueOnce(promise);
      } else {
        ctx.params.onBlockReplyFlush = () => promise;
      }
      const end = handleAgentEnd(ctx);
      expect(ctx.maybeResolveCompactionWait).toHaveBeenCalledTimes(1);
      expect(ctx.resolveCompactionRetry).not.toHaveBeenCalled();
      expect(onAgentEvent).not.toHaveBeenCalled();
      resolve();
      await end;
      expectEvent(onAgentEvent, {
        phase: "error",
        error: "LLM request failed: connection refused by the provider endpoint.",
        errorObservation: expect.objectContaining({ providerRuntimeFailureKind: "timeout" }),
        livenessState: "blocked",
      });
    },
  );
  it("resolves compaction retry after a timed-out terminal hook finalizes the original answer", async () => {
    vi.useFakeTimers();
    try {
      const logger = { error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      const runner = createHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_agent_finalize",
            handler: vi.fn(() => new Promise(() => {})),
          },
        ]),
        { logger },
      );
      const onBeforeTerminalDelivery = vi.fn(async () => {
        await runner.runBeforeAgentFinalize(BEFORE_AGENT_FINALIZE_EVENT, TEST_PLUGIN_AGENT_CTX);
      });
      const ctx = createContext(
        {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stopReason: "stop",
        },
        { onBeforeTerminalDelivery },
      );
      ctx.state.assistantTexts = ["done"];
      ctx.state.pendingCompactionRetry = 1;

      const endPromise = handleAgentEnd(ctx);
      await Promise.resolve();

      expect(onBeforeTerminalDelivery).toHaveBeenCalledTimes(1);
      expect(ctx.resolveCompactionRetry).not.toHaveBeenCalled();
      expect(ctx.flushBlockReplyBuffer).not.toHaveBeenCalledWith({ final: true });

      await vi.advanceTimersByTimeAsync(15_000);
      await endPromise;

      expect(logger.error).toHaveBeenCalledWith(
        "[hooks] before_agent_finalize handler from test-plugin failed: timed out after 15000ms",
      );
      expect(ctx.clearAssistantStream).not.toHaveBeenCalled();
      expect(ctx.clearDeferredBlockReplies).not.toHaveBeenCalled();
      expect(ctx.releaseDeferredReplies).toHaveBeenCalledTimes(1);
      expect(ctx.flushBlockReplyBuffer).toHaveBeenCalledWith({ final: true });
      expect(ctx.resolveCompactionRetry).toHaveBeenCalledTimes(1);
      expect(ctx.maybeResolveCompactionWait).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["throw", "reject"] as const)(
    "settles a %s before-lifecycle callback before terminal emission",
    async (kind) => {
      const order: string[] = [];
      const onAgentEvent = vi.fn(() => {
        order.push("event");
      });
      const onBeforeLifecycleTerminal = vi.fn(() => {
        if (kind === "throw") {
          order.push("before");
          throw new Error("hook failed");
        }
        return Promise.resolve().then(() => {
          order.push("before");
          throw new Error("hook failed");
        });
      });
      await handleAgentEnd(createContext(undefined, { onAgentEvent, onBeforeLifecycleTerminal }));
      expect(order).toEqual(["before", "event"]);
      expect(onBeforeLifecycleTerminal).toHaveBeenCalledTimes(1);
      expectEvent(onAgentEvent, { phase: "end" });
    },
  );
  it.each(["block reject", "block throw"] as const)(
    "still emits a terminal event after %s",
    async (kind) => {
      const onAgentEvent = vi.fn();
      const ctx = createContext(undefined, { onAgentEvent });
      const fail = () => {
        throw new Error("flush failed");
      };
      ctx.flushBlockReplyBuffer = kind === "block throw" ? fail : async () => fail();
      if (kind === "block throw") {
        expect(() => handleAgentEnd(ctx)).toThrow("flush failed");
      } else {
        await expect(handleAgentEnd(ctx)).rejects.toThrow("flush failed");
      }
      expectEvent(onAgentEvent, { phase: "end" });
    },
  );
});
