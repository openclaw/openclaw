import { createLlmRuntime, createNodeLlmRuntime, getAiTransportHost } from "@openclaw/ai";
import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
} from "../../../../packages/ai/src/providers/openai-chatgpt-responses.js";
import {
  createJwt,
  completedResponse as completedFrame,
} from "../../../../packages/ai/src/providers/openai-chatgpt-responses.test-helpers.js";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
// Installs the same transport host as the runtime.
import "../../../llm/stream.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import type { StreamFn } from "../../runtime/index.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { UNKNOWN_TOOL_THRESHOLD } from "../../tool-loop-detection.js";
import { runEmbeddedSessionFork } from "../session-fork.js";
import { resolveEmbeddedAgentStream } from "../stream-resolution.js";
import { wrapStreamFnHandleSensitiveStopReason } from "./attempt-stop-reason-recovery.js";
import { wrapStreamFnTrimToolCallNames } from "./attempt-tool-call-stream-normalization.js";
import { wrapStreamFnPromoteStandaloneTextToolCalls } from "./attempt-tool-call-text-promotion.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./attempt.model-diagnostic-events.js";
import { wrapStreamFnRepairMalformedToolCallArguments } from "./attempt.tool-call-argument-repair.js";
import {
  resolveLlmFirstEventTimeoutMs,
  resolveLlmIdleTimeoutMs,
  streamWithIdleTimeout,
} from "./llm-idle-timeout.js";

const apiKey = createJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });

const model = makeProviderModelFixture({
  id: "test-codex-model",
  api: "openai-chatgpt-responses",
  provider: "openai",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  reasoning: true,
  contextWindow: 372_000,
  maxTokens: 16_000,
});

const context = {
  systemPrompt: "You are a test.",
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
} as Parameters<StreamFn>[1];

const llmRuntime = createLlmRuntime();
registerBuiltInApiProviders(llmRuntime.registry);

type Frame = Record<string, unknown>;

class ControlledWebSocket extends EventTarget {
  static instances: ControlledWebSocket[] = [];
  static onSend?: (socket: ControlledWebSocket, payload: string) => void;
  static onOpen?: () => void;
  readyState = 1;
  sent: string[] = [];
  closeCalls: Array<[number | undefined, string | undefined]> = [];

  constructor() {
    super();
    ControlledWebSocket.instances.push(this);
    queueMicrotask(() => {
      ControlledWebSocket.onOpen?.();
      this.dispatchEvent(new Event("open"));
    });
  }

  send(payload: string): void {
    this.sent.push(payload);
    ControlledWebSocket.onSend?.(this, payload);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push([code, reason]);
    this.readyState = 3;
  }

  deliver(frame: Frame): void {
    this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(frame) }));
  }

  fail(): void {
    this.dispatchEvent(Object.assign(new Event("error"), { message: "WebSocket error" }));
  }
}

function startWatchdog(label: string) {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 500 })),
  );
  const onIdleTimeout = vi.fn();
  const runAbort = new AbortController();
  const runId = `run-${label}`;
  const sessionId = `session-${label}`;
  const cfg = { agents: { defaults: { timeoutSeconds: 3600 } } };
  const { streamFn: base, strategy } = resolveEmbeddedAgentStream({
    llmRuntime,
    currentStreamFn: undefined,
    sessionId,
    signal: runAbort.signal,
    model: model as never,
    resolvedApiKey: apiKey,
    authProfileId: "openai:default",
  });
  const allowed = new Set(["exec", "read"]);
  let streamFn: StreamFn = base;
  streamFn = wrapStreamFnPromoteStandaloneTextToolCalls(streamFn, allowed);
  streamFn = wrapStreamFnTrimToolCallNames(streamFn, allowed, {
    unknownToolThreshold: UNKNOWN_TOOL_THRESHOLD,
  });
  streamFn = wrapStreamFnRepairMalformedToolCallArguments(streamFn);
  streamFn = wrapStreamFnHandleSensitiveStopReason(streamFn);
  const timeoutOptions = {
    cfg,
    runTimeoutMs: undefined,
    modelRequestTimeoutMs: undefined,
    model: { baseUrl: model.baseUrl, id: model.id, provider: model.provider },
  };
  const idleTimeoutMs = resolveLlmIdleTimeoutMs({ ...timeoutOptions, trigger: "user" });
  const firstEventTimeoutMs = resolveLlmFirstEventTimeoutMs(timeoutOptions);
  streamFn = streamWithIdleTimeout(streamFn, idleTimeoutMs, onIdleTimeout, {
    runId,
  });
  const beforeFirstEvent = streamFn;
  streamFn = (m, c, options) =>
    beforeFirstEvent(m, c, {
      ...options,
      firstEventTimeoutMs,
      onFirstEventTimeout: onIdleTimeout,
    } as typeof options);
  let seq = 0;
  streamFn = wrapStreamFnWithDiagnosticModelCallEvents(streamFn, {
    runId,
    sessionId,
    provider: model.provider,
    model: model.id,
    api: model.api,
    transport: "auto",
    requestTimeoutMs: idleTimeoutMs,
    trace: createDiagnosticTraceContext(),
    nextCallId: () => `${runId}:model:${(seq += 1)}`,
  });
  return { streamFn, idleTimeoutMs, firstEventTimeoutMs, strategy, onIdleTimeout, runAbort };
}

async function consumeLikeAgentCore(
  streamFn: StreamFn,
  executionSignal: AbortSignal,
  onEvent?: (type: string) => Promise<void> | void,
) {
  const response = await streamFn(model as never, context, {
    apiKey,
    signal: executionSignal,
    asyncToolExecution: true,
  } as Parameters<StreamFn>[2]);
  const events: string[] = [];
  let thrown: unknown;
  try {
    for await (const event of response) {
      events.push(event.type);
      await onEvent?.(event.type);
      if (event.type === "done" || event.type === "error") {
        break;
      }
    }
  } catch (error) {
    thrown = error;
  }
  const result = thrown ? undefined : await response.result();
  return { events, result, thrown };
}

function deliverOnSend(id: string) {
  ControlledWebSocket.onSend = (socket) => {
    queueMicrotask(() => socket.deliver({ type: "response.created", response: { id } }));
  };
}

function textFrames(id: string, itemId: string, text: string): Frame[] {
  const item = {
    type: "message",
    id: itemId,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id, status: "completed", output: [item] } },
  ];
}

function runFork(
  identity: { agentId: string; sessionId: string; runId: string },
  question: string,
  streamFn: StreamFn,
  assertCurrent = () => {},
  promptCacheKey?: string,
) {
  return runEmbeddedSessionFork({
    context,
    streamFn,
    options: { sessionId: identity.sessionId, transport: "auto", promptCacheKey },
    model,
    apiKey,
    question,
    assertCurrent,
  });
}

function parkConsumer(streamFn: StreamFn, signal: AbortSignal) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const consumed = consumeLikeAgentCore(streamFn, signal, async (type) => {
    if (type === "start") {
      entered.resolve();
      await release.promise;
    }
  });
  return { entered: entered.promise, release: release.resolve, consumed };
}

async function expectIdleDeadline(onIdleTimeout: ReturnType<typeof vi.fn>) {
  await vi.advanceTimersByTimeAsync(119_000);
  expect(onIdleTimeout).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(onIdleTimeout).toHaveBeenCalledTimes(1);
}

function forkParent(sessionId: string, runtime = llmRuntime) {
  const identity = { agentId: "main", sessionId, runId: "parent" };
  const parent: StreamFn = (requestModel, requestContext, options) =>
    runtime.streamSimple(requestModel, requestContext, options);
  return { identity, parent };
}

const followupContext = {
  ...context,
  messages: [
    ...context.messages,
    { role: "user" as const, content: "Continue parent", timestamp: 2 },
  ],
};

describe("codex websocket idle watchdog through the embedded runner chain", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", ControlledWebSocket));
  afterEach(() => {
    closeOpenAICodexWebSocketSessions();
    resetOpenAICodexWebSocketStateForTest();
    cleanupSessionResources();
    ControlledWebSocket.instances = [];
    ControlledWebSocket.onSend = undefined;
    ControlledWebSocket.onOpen = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("blocks a native fork send when authority is revoked during websocket acquisition", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    ControlledWebSocket.onSend = (socket) => {
      queueMicrotask(() => socket.deliver(completedFrame("resp_fork")));
    };
    const { identity, parent } = forkParent("native-fork-revocation");
    expect(
      (await (await parent(model, context, { apiKey, transport: "websocket" })).result())
        .stopReason,
    ).toBe("stop");
    expect(ControlledWebSocket.instances[0]?.sent).toHaveLength(1);
    let current = true;
    ControlledWebSocket.onOpen = () => {
      current = false;
    };
    await expect(
      runFork(identity, "Review without dispatch after revocation", parent, () => {
        if (!current) {
          throw new Error("Session read authority revoked");
        }
      }),
    ).rejects.toThrow("Session read authority revoked");
    expect(ControlledWebSocket.instances).toHaveLength(2);
    expect(ControlledWebSocket.instances[1]?.sent).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([undefined, "parent-key"])(
    "omits native fork affinity without replacing the parent's continuation (source key=%s)",
    async (promptCacheKey) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const requests: Frame[] = [];
      ControlledWebSocket.onSend = (socket, payload) => {
        requests.push(JSON.parse(payload) as Frame);
        const id = `resp_native_${requests.length}`;
        const isFork = requests.length === 2;
        queueMicrotask(() => {
          socket.deliver({ type: "response.created", response: { id } });
          if (isFork) {
            for (const frame of textFrames(id, "msg_native_fork", "Independent review")) {
              socket.deliver(frame);
            }
          } else {
            socket.deliver(completedFrame(id));
          }
        });
      };
      const { identity, parent } = forkParent("native-fork-independent");
      const options = {
        apiKey,
        sessionId: identity.sessionId,
        transport: "websocket-cached" as const,
      };
      expect((await (await parent(model, context, options)).result()).stopReason).toBe("stop");
      await expect(
        runFork(identity, "Review independently", parent, undefined, promptCacheKey),
      ).resolves.toBe("Independent review");
      expect((await (await parent(model, followupContext, options)).result()).stopReason).toBe(
        "stop",
      );
      expect(ControlledWebSocket.instances.map((socket) => socket.sent.length)).toEqual([2, 1]);
      expect(ControlledWebSocket.instances[1]?.closeCalls).toHaveLength(1);
      expect(requests[1]).not.toHaveProperty("previous_response_id");
      expect(requests[1]).toMatchObject({
        input: [
          { role: "user", content: [{ type: "input_text", text: "hi" }] },
          { role: "user", content: [{ type: "input_text", text: "Review independently" }] },
        ],
      });
      expect(requests[0]?.prompt_cache_key).toBe(identity.sessionId);
      expect(requests[1]).not.toHaveProperty("prompt_cache_key");
      expect(requests[2]).toMatchObject({
        previous_response_id: "resp_native_1",
        input: [{ role: "user", content: [{ type: "input_text", text: "Continue parent" }] }],
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("keeps the parent's native auto transport after an independent fork falls back to SSE", async () => {
    const fetchMock = vi.fn(async () => {
      const events = [
        { type: "response.created", response: { id: "resp_fallback_fork" } },
        ...textFrames("resp_fallback_fork", "msg_fallback_fork", "Fallback review"),
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = createNodeLlmRuntime(llmRuntime.registry, {
      ...getAiTransportHost(),
      buildModelFetch: () => fetchMock,
    });
    ControlledWebSocket.onSend = (socket) => {
      queueMicrotask(() => {
        if (socket === ControlledWebSocket.instances[1]) {
          socket.fail();
        } else {
          socket.deliver(completedFrame(`resp_parent_${socket.sent.length}`));
        }
      });
    };
    const { identity, parent } = forkParent("native-fork-fallback", runtime);
    const options = { apiKey, sessionId: identity.sessionId, transport: "auto" as const };
    expect((await (await parent(model, context, options)).result()).stopReason).toBe("stop");
    await expect(
      runFork(identity, "Review with independent transport recovery", parent),
    ).resolves.toBe("Fallback review");
    expect((await (await parent(model, followupContext, options)).result()).stopReason).toBe(
      "stop",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(ControlledWebSocket.instances.map((socket) => socket.sent.length)).toEqual([2, 1]);
    expect(JSON.parse(ControlledWebSocket.instances[0]?.sent[1] ?? "{}")).toMatchObject({
      previous_response_id: "resp_parent_1",
      input: [{ role: "user", content: [{ type: "input_text", text: "Continue parent" }] }],
    });
  });

  it("A: fresh socket that never sends is aborted at the idle timeout", async () => {
    const { streamFn, idleTimeoutMs, firstEventTimeoutMs, strategy, onIdleTimeout, runAbort } =
      startWatchdog("A");
    expect(strategy).toBe("openclaw-native-codex-responses");
    expect([idleTimeoutMs, firstEventTimeoutMs]).toEqual([120_000, 120_000]);
    const consumed = consumeLikeAgentCore(streamFn, runAbort.signal);
    await vi.advanceTimersByTimeAsync(10);
    const socket = ControlledWebSocket.instances[0];
    expect(socket?.sent).toHaveLength(1);
    await expectIdleDeadline(onIdleTimeout);
    expect(String(onIdleTimeout.mock.calls[0]?.[0]?.message)).toMatch(
      /idle timeout|first-event timeout/,
    );
    const { events, result, thrown } = await consumed;
    expect(String((thrown as Error | undefined)?.message ?? result?.errorMessage)).toMatch(
      /idle timeout|first-event timeout/,
    );
    expect(events.length).toBeLessThanOrEqual(1);
    expect(socket?.closeCalls.length).toBeGreaterThan(0);
  });

  it("C: cached session socket reused from a previous call, then one frame and a stall, is aborted at the idle timeout", async () => {
    ControlledWebSocket.onSend = (socket) => {
      const call = socket.sent.length;
      queueMicrotask(() => {
        socket.deliver({ type: "response.created", response: { id: `resp_${call}` } });
        if (call === 1) {
          socket.deliver(completedFrame("resp_1"));
        }
      });
    };
    const { streamFn, onIdleTimeout, runAbort } = startWatchdog("C");
    const first = await consumeLikeAgentCore(streamFn, runAbort.signal);
    expect(first.result?.stopReason).toBe("stop");
    expect(ControlledWebSocket.instances).toHaveLength(1);
    const consumed = consumeLikeAgentCore(streamFn, runAbort.signal);
    await vi.advanceTimersByTimeAsync(10);
    expect(ControlledWebSocket.instances).toHaveLength(1);
    expect(ControlledWebSocket.instances[0]?.sent).toHaveLength(2);
    await expectIdleDeadline(onIdleTimeout);
    const { result, thrown } = await consumed;
    expect(String((thrown as Error | undefined)?.message ?? result?.errorMessage)).toMatch(
      /idle timeout/,
    );
  });

  it("D: consumer parked in emit() after start is still policed by the idle watchdog", async () => {
    deliverOnSend("resp_d");
    const { streamFn, onIdleTimeout, runAbort } = startWatchdog("D");
    const { entered, release, consumed } = parkConsumer(streamFn, runAbort.signal);
    await vi.advanceTimersByTimeAsync(10);
    await entered;
    await vi.advanceTimersByTimeAsync(119_000);
    expect(onIdleTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    // The consumer is still parked; the dead socket is aborted anyway.
    expect(onIdleTimeout).toHaveBeenCalledTimes(1);
    expect(String(onIdleTimeout.mock.calls[0]?.[0]?.message)).toMatch(/idle timeout/);
    expect(ControlledWebSocket.instances[0]?.closeCalls.length).toBeGreaterThan(0);

    release();
    await vi.advanceTimersByTimeAsync(10);
    const { result, thrown } = await consumed;
    expect(String((thrown as Error | undefined)?.message ?? result?.errorMessage)).toMatch(
      /idle timeout|aborted/,
    );
  });

  it.each([
    { activity: "bookkeeping", parked: true },
    { activity: "hidden reasoning", parked: true },
    { activity: "empty reasoning", parked: false },
    { activity: "repeated snapshot", parked: false },
    { activity: "hidden reasoning", parked: false },
  ] as const)(
    "F: distinguishes activity from progress ($activity, parked=$parked)",
    async ({ activity, parked }) => {
      ControlledWebSocket.onSend = (socket) => {
        queueMicrotask(() => {
          socket.deliver({ type: "response.created", response: { id: "resp_f" } });
          if (activity !== "bookkeeping") {
            socket.deliver({
              type: "response.output_item.added",
              output_index: 0,
              item: { id: "reasoning_f", type: "reasoning", summary: [] },
            });
          }
        });
      };
      const { streamFn, onIdleTimeout, runAbort } = startWatchdog(`F-${activity}-${parked}`);
      const emitEntered = createDeferredCore();
      const releaseEmit = createDeferredCore();
      const consumed = consumeLikeAgentCore(streamFn, runAbort.signal, async (type) => {
        if (type === "start") {
          emitEntered.resolve();
          if (parked) {
            await releaseEmit.promise;
          }
        }
      });
      await vi.advanceTimersByTimeAsync(10);
      await emitEntered.promise;
      const socket = ControlledWebSocket.instances[0];
      // Both kinds arrive inside the connection's 120s window. Only genuine
      // reasoning is allowed to extend the independent 15-minute progress deadline.
      const progress = setInterval(() => {
        socket?.deliver(
          activity === "bookkeeping"
            ? { type: "response.in_progress", response: { id: "resp_f" } }
            : activity === "repeated snapshot"
              ? {
                  type: "response.output_item.done",
                  output_index: 0,
                  item: { id: "reasoning_f", type: "reasoning", summary: [] },
                }
              : {
                  type: "response.reasoning_text.delta",
                  item_id: "reasoning_f",
                  output_index: 0,
                  delta: activity === "empty reasoning" ? "" : "Synthetic hidden progress",
                },
        );
      }, 60_000);
      await vi.advanceTimersByTimeAsync(1_020_000);
      clearInterval(progress);
      if (activity !== "hidden reasoning") {
        expect(onIdleTimeout).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ message: "LLM idle timeout (900s): no model progress" }),
        );
      } else {
        expect(onIdleTimeout).not.toHaveBeenCalled();
        socket?.deliver(completedFrame("resp_f"));
      }
      releaseEmit.resolve();
      await vi.advanceTimersByTimeAsync(10);
      const { result, thrown } = await consumed;
      if (activity !== "hidden reasoning") {
        expect(String((thrown as Error | undefined)?.message ?? result?.errorMessage)).toMatch(
          /no model progress|aborted/,
        );
      } else {
        expect(thrown).toBeUndefined();
        expect(result?.stopReason).toBe("stop");
        expect(onIdleTimeout).not.toHaveBeenCalled();
      }
    },
  );
});
