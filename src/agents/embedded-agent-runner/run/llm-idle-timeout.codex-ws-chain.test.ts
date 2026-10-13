// Full embedded-runner stream wrapper chain around the real Codex Responses
// provider with a mocked WebSocket, proving the idle watchdog polices provider
// silence in the shapes seen live (fresh, cached, and consumer-parked streams).
import { createLlmRuntime, createNodeLlmRuntime, getAiTransportHost } from "@openclaw/ai";
import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
} from "../../../../packages/ai/src/providers/openai-chatgpt-responses.js";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import type { Model } from "../../../llm/types.js";
// Installs the OpenClaw transport host exactly like the runtime does.
import "../../../llm/stream.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import type { StreamFn } from "../../runtime/index.js";
import { UNKNOWN_TOOL_THRESHOLD } from "../../tool-loop-detection.js";
import {
  clearEmbeddedSessionForkSnapshot,
  runEmbeddedSessionFork,
  wrapStreamFnWithSessionFork,
} from "../session-fork.js";
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

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

const apiKey = createJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });

const model = {
  id: "test-codex-model",
  name: "test-codex-model",
  api: "openai-chatgpt-responses",
  provider: "openai",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 372_000,
  maxTokens: 16_000,
} as unknown as Model;

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

function completedFrame(id: string): Frame {
  return {
    type: "response.completed",
    response: {
      id,
      status: "completed",
      output: [],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  };
}

function buildRunnerChain(params: {
  runId: string;
  sessionId: string;
  runSignal: AbortSignal;
  onIdleTimeout: (error: Error) => void;
}): { streamFn: StreamFn; idleTimeoutMs: number; firstEventTimeoutMs: number; strategy: string } {
  const cfg = { agents: { defaults: { timeoutSeconds: 3600 } } };
  const { streamFn: base, strategy } = resolveEmbeddedAgentStream({
    llmRuntime,
    currentStreamFn: undefined,
    sessionId: params.sessionId,
    signal: params.runSignal,
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
  streamFn = streamWithIdleTimeout(streamFn, idleTimeoutMs, params.onIdleTimeout, {
    runId: params.runId,
  });
  const beforeFirstEvent = streamFn;
  streamFn = (m, c, options) =>
    beforeFirstEvent(m, c, {
      ...options,
      firstEventTimeoutMs,
      onFirstEventTimeout: params.onIdleTimeout,
    } as typeof options);
  let seq = 0;
  streamFn = wrapStreamFnWithDiagnosticModelCallEvents(streamFn, {
    runId: params.runId,
    sessionId: params.sessionId,
    provider: model.provider,
    model: model.id,
    api: model.api,
    transport: "auto",
    requestTimeoutMs: idleTimeoutMs,
    trace: createDiagnosticTraceContext(),
    nextCallId: () => `${params.runId}:model:${(seq += 1)}`,
  });
  return { streamFn, idleTimeoutMs, firstEventTimeoutMs, strategy };
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
    // The runner surfaces idle timeouts as a thrown error from next(), not as an event.
    thrown = error;
  }
  const result = thrown ? undefined : await response.result();
  return { events, result, thrown };
}

describe("codex websocket idle watchdog through the embedded runner chain", () => {
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
    vi.stubGlobal("WebSocket", ControlledWebSocket);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    ControlledWebSocket.onSend = (socket) => {
      queueMicrotask(() => socket.deliver(completedFrame("resp_fork")));
    };
    const identity = { agentId: "main", sessionId: "native-fork-revocation" };
    const parent = wrapStreamFnWithSessionFork(
      (requestModel, requestContext, options) =>
        llmRuntime.streamSimple(requestModel, requestContext, options),
      identity,
    );
    const parentResult = await (
      await parent(model, context, { apiKey, transport: "websocket" })
    ).result();
    expect(parentResult.stopReason).toBe("stop");
    expect(ControlledWebSocket.instances[0]?.sent).toHaveLength(1);

    ControlledWebSocket.onOpen = () => clearEmbeddedSessionForkSnapshot(identity.sessionId);
    await expect(
      runEmbeddedSessionFork({
        ...identity,
        model,
        apiKey,
        question: "Review without dispatch after revocation",
        assertCurrent: () => {},
      }),
    ).rejects.toThrow("Cache-parity session fork requires a parent turn");

    expect(ControlledWebSocket.instances).toHaveLength(2);
    expect(ControlledWebSocket.instances[1]?.sent).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("isolates a native session fork without consuming or replacing the parent's cached continuation", async () => {
    vi.stubGlobal("WebSocket", ControlledWebSocket);
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
          const item = {
            type: "message",
            id: "msg_native_fork",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Independent review", annotations: [] }],
          };
          socket.deliver({
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, content: [] },
          });
          socket.deliver({ type: "response.output_item.done", output_index: 0, item });
          socket.deliver({
            type: "response.completed",
            response: { id, status: "completed", output: [item] },
          });
        } else {
          socket.deliver(completedFrame(id));
        }
      });
    };
    const identity = { agentId: "main", sessionId: "native-fork-independent" };
    const parent = wrapStreamFnWithSessionFork(
      (requestModel, requestContext, options) =>
        llmRuntime.streamSimple(requestModel, requestContext, options),
      identity,
    );
    const options = {
      apiKey,
      sessionId: identity.sessionId,
      transport: "websocket-cached" as const,
    };
    expect((await (await parent(model, context, options)).result()).stopReason).toBe("stop");

    await expect(
      runEmbeddedSessionFork({
        ...identity,
        model,
        apiKey,
        question: "Review independently",
        assertCurrent: () => {},
      }),
    ).resolves.toBe("Independent review");

    const followupContext = {
      ...context,
      messages: [
        ...context.messages,
        { role: "user" as const, content: "Continue parent", timestamp: 2 },
      ],
    };
    expect((await (await parent(model, followupContext, options)).result()).stopReason).toBe(
      "stop",
    );

    expect(ControlledWebSocket.instances).toHaveLength(2);
    expect(ControlledWebSocket.instances[0]?.sent).toHaveLength(2);
    expect(ControlledWebSocket.instances[1]?.sent).toHaveLength(1);
    expect(ControlledWebSocket.instances[1]?.closeCalls).toHaveLength(1);
    expect(requests[1]).not.toHaveProperty("previous_response_id");
    expect(requests[1]).toMatchObject({
      prompt_cache_key: identity.sessionId,
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "user", content: [{ type: "input_text", text: "Review independently" }] },
      ],
    });
    expect(requests[2]).toMatchObject({
      previous_response_id: "resp_native_1",
      input: [{ role: "user", content: [{ type: "input_text", text: "Continue parent" }] }],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the parent's native auto transport after an independent fork falls back to SSE", async () => {
    vi.stubGlobal("WebSocket", ControlledWebSocket);
    const item = {
      type: "message",
      id: "msg_fallback_fork",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Fallback review", annotations: [] }],
    };
    const fetchMock = vi.fn(async () => {
      const events = [
        { type: "response.created", response: { id: "resp_fallback_fork" } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: { id: "resp_fallback_fork", status: "completed", output: [item] },
        },
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
    const identity = { agentId: "main", sessionId: "native-fork-fallback" };
    const parent = wrapStreamFnWithSessionFork(
      (requestModel, requestContext, options) =>
        runtime.streamSimple(requestModel, requestContext, options),
      identity,
    );
    const options = { apiKey, sessionId: identity.sessionId, transport: "auto" as const };
    expect((await (await parent(model, context, options)).result()).stopReason).toBe("stop");
    await expect(
      runEmbeddedSessionFork({
        ...identity,
        model,
        apiKey,
        question: "Review with independent transport recovery",
        assertCurrent: () => {},
      }),
    ).resolves.toBe("Fallback review");

    const followupContext = {
      ...context,
      messages: [
        ...context.messages,
        { role: "user" as const, content: "Continue parent", timestamp: 2 },
      ],
    };
    expect((await (await parent(model, followupContext, options)).result()).stopReason).toBe(
      "stop",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(ControlledWebSocket.instances).toHaveLength(2);
    expect(ControlledWebSocket.instances[0]?.sent).toHaveLength(2);
    expect(ControlledWebSocket.instances[1]?.sent).toHaveLength(1);
    expect(JSON.parse(ControlledWebSocket.instances[0]?.sent[1] ?? "{}")).toMatchObject({
      previous_response_id: "resp_parent_1",
      input: [{ role: "user", content: [{ type: "input_text", text: "Continue parent" }] }],
    });
  });

  it("A: fresh socket that never sends is aborted at the idle timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ControlledWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );
    const onIdleTimeout = vi.fn();
    const runAbort = new AbortController();
    const { streamFn, idleTimeoutMs, firstEventTimeoutMs, strategy } = buildRunnerChain({
      runId: "run-A",
      sessionId: "session-A",
      runSignal: runAbort.signal,
      onIdleTimeout,
    });
    expect(strategy).toBe("openclaw-native-codex-responses");
    expect([idleTimeoutMs, firstEventTimeoutMs]).toEqual([120_000, 120_000]);

    const consumed = consumeLikeAgentCore(streamFn, runAbort.signal);
    await vi.advanceTimersByTimeAsync(10);
    const socket = ControlledWebSocket.instances[0];
    expect(socket?.sent).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(119_000);
    expect(onIdleTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onIdleTimeout).toHaveBeenCalledTimes(1);
    expect(String(onIdleTimeout.mock.calls[0]?.[0]?.message)).toMatch(
      /idle timeout|first-event timeout/,
    );

    const { events, result, thrown } = await consumed;
    // Idle timeout surfaces as a thrown error from next(); the provider stream is aborted.
    expect(String((thrown as Error | undefined)?.message ?? result?.errorMessage)).toMatch(
      /idle timeout|first-event timeout/,
    );
    // Depending on wrapper ordering the abort surfaces as a throw or as an error event.
    expect(events.length).toBeLessThanOrEqual(1);
    expect(socket?.closeCalls.length).toBeGreaterThan(0);
  });

  it("C: cached session socket reused from a previous call, then one frame and a stall, is aborted at the idle timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ControlledWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );
    let call = 0;
    ControlledWebSocket.onSend = (socket) => {
      call += 1;
      const current = call;
      queueMicrotask(() => {
        if (current === 1) {
          socket.deliver({ type: "response.created", response: { id: "resp_1" } });
          socket.deliver(completedFrame("resp_1"));
          return;
        }
        socket.deliver({ type: "response.created", response: { id: "resp_2" } });
      });
    };
    const onIdleTimeout = vi.fn();
    const runAbort = new AbortController();
    const { streamFn } = buildRunnerChain({
      runId: "run-C",
      sessionId: "session-C",
      runSignal: runAbort.signal,
      onIdleTimeout,
    });

    const first = await consumeLikeAgentCore(streamFn, runAbort.signal);
    expect(first.result?.stopReason).toBe("stop");
    expect(ControlledWebSocket.instances).toHaveLength(1);

    const consumed = consumeLikeAgentCore(streamFn, runAbort.signal);
    await vi.advanceTimersByTimeAsync(10);
    // Same socket object reused for the second call.
    expect(ControlledWebSocket.instances).toHaveLength(1);
    expect(ControlledWebSocket.instances[0]?.sent).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(119_000);
    expect(onIdleTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onIdleTimeout).toHaveBeenCalledTimes(1);
    const { result, thrown } = await consumed;
    expect(String((thrown as Error | undefined)?.message ?? result?.errorMessage)).toMatch(
      /idle timeout/,
    );
  });

  it("D: consumer parked in emit() after start is still policed by the idle watchdog", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ControlledWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );
    ControlledWebSocket.onSend = (socket) => {
      queueMicrotask(() =>
        socket.deliver({ type: "response.created", response: { id: "resp_d" } }),
      );
    };
    const onIdleTimeout = vi.fn();
    const runAbort = new AbortController();
    const { streamFn } = buildRunnerChain({
      runId: "run-D",
      sessionId: "session-D",
      runSignal: runAbort.signal,
      onIdleTimeout,
    });
    const emitEntered = createDeferredCore();
    const releaseEmit = createDeferredCore();
    const consumed = consumeLikeAgentCore(streamFn, runAbort.signal, async (type) => {
      if (type === "start") {
        emitEntered.resolve();
        await releaseEmit.promise;
      }
    });
    await vi.advanceTimersByTimeAsync(10);
    await emitEntered.promise;
    await vi.advanceTimersByTimeAsync(119_000);
    expect(onIdleTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    // The consumer is still parked; the dead socket is aborted anyway.
    expect(onIdleTimeout).toHaveBeenCalledTimes(1);
    expect(String(onIdleTimeout.mock.calls[0]?.[0]?.message)).toMatch(/idle timeout/);
    expect(ControlledWebSocket.instances[0]?.closeCalls.length).toBeGreaterThan(0);

    releaseEmit.resolve();
    await vi.advanceTimersByTimeAsync(10);
    const { result, thrown } = await consumed;
    expect(String((thrown as Error | undefined)?.message ?? result?.errorMessage)).toMatch(
      /idle timeout|aborted/,
    );
  });

  it("F: frames arriving while the consumer is parked keep the watchdog alive", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ControlledWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );
    ControlledWebSocket.onSend = (socket) => {
      queueMicrotask(() =>
        socket.deliver({ type: "response.created", response: { id: "resp_f" } }),
      );
    };
    const onIdleTimeout = vi.fn();
    const runAbort = new AbortController();
    const { streamFn } = buildRunnerChain({
      runId: "run-F",
      sessionId: "session-F",
      runSignal: runAbort.signal,
      onIdleTimeout,
    });
    const emitEntered = createDeferredCore();
    const releaseEmit = createDeferredCore();
    const consumed = consumeLikeAgentCore(streamFn, runAbort.signal, async (type) => {
      if (type === "start") {
        emitEntered.resolve();
        await releaseEmit.promise;
      }
    });
    await vi.advanceTimersByTimeAsync(10);
    await emitEntered.promise;
    const socket = ControlledWebSocket.instances[0];
    // The provider keeps streaming bookkeeping frames every 60s (under the 120s budget).
    const progress = setInterval(() => {
      socket?.deliver({ type: "response.in_progress", response: { id: "resp_f" } });
    }, 60_000);
    await vi.advanceTimersByTimeAsync(300_000);
    clearInterval(progress);
    expect(onIdleTimeout).not.toHaveBeenCalled();

    socket?.deliver(completedFrame("resp_f"));
    releaseEmit.resolve();
    await vi.advanceTimersByTimeAsync(10);
    const { result, thrown } = await consumed;
    expect(thrown).toBeUndefined();
    expect(result?.stopReason).toBe("stop");
    expect(onIdleTimeout).not.toHaveBeenCalled();
  });
});
