import { createLlmRuntime } from "@openclaw/ai";
import {
  claimConversationProviderState,
  cleanupSessionResources,
} from "@openclaw/ai/internal/runtime";
import { PROVIDER_STATE_SCOPE } from "@openclaw/ai/provider-types";
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
  const { streamFn: resolved, strategy } = resolveEmbeddedAgentStream({
    llmRuntime,
    currentStreamFn: undefined,
    sessionId,
    signal: runAbort.signal,
    model: model as never,
    resolvedApiKey: apiKey,
    authProfileId: "openai:default",
  });
  // The writer's attempt owns the session socket, as attempt-stream-settle supplies in a run.
  const base: StreamFn = (streamModel, streamContext, options) =>
    resolved(streamModel, streamContext, {
      ...options,
      [PROVIDER_STATE_SCOPE]: claimConversationProviderState(sessionId),
    } as Parameters<StreamFn>[2]);
  const allowed = new Set(["exec", "read"]);
  const promoted = wrapStreamFnPromoteStandaloneTextToolCalls(base, allowed);
  const trimmed = wrapStreamFnTrimToolCallNames(promoted, allowed, {
    unknownToolThreshold: 10,
  });
  const timeoutOptions = {
    cfg: { agents: { defaults: { timeoutSeconds: 3600 } } },
    model,
  };
  const idleTimeoutMs = resolveLlmIdleTimeoutMs({ ...timeoutOptions, trigger: "user" });
  const firstEventTimeoutMs = resolveLlmFirstEventTimeoutMs(timeoutOptions);
  const beforeFirstEvent = streamWithIdleTimeout(
    wrapStreamFnHandleSensitiveStopReason(wrapStreamFnRepairMalformedToolCallArguments(trimmed)),
    idleTimeoutMs,
    onIdleTimeout,
    { runId },
  );
  const withFirstEvent: StreamFn = (m, c, options) =>
    beforeFirstEvent(m, c, {
      ...options,
      firstEventTimeoutMs,
      onFirstEventTimeout: onIdleTimeout,
    } as typeof options);
  let seq = 0;
  const streamFn = wrapStreamFnWithDiagnosticModelCallEvents(withFirstEvent, {
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

function parkConsumer(streamFn: StreamFn, signal: AbortSignal, parked = true) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const consumed = consumeLikeAgentCore(streamFn, signal, async (type) => {
    if (type === "start") {
      entered.resolve();
      if (parked) {
        await release.promise;
      }
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

function expectStreamFailure(
  { result, thrown }: Awaited<ReturnType<typeof consumeLikeAgentCore>>,
  message: RegExp,
) {
  expect(String((thrown as Error | undefined)?.message ?? result?.errorMessage)).toMatch(message);
}

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
    const outcome = await consumed;
    expectStreamFailure(outcome, /idle timeout|first-event timeout/);
    expect(outcome.events.length).toBeLessThanOrEqual(1);
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
    expectStreamFailure(await consumed, /idle timeout/);
  });

  it("D: consumer parked in emit() after start is still policed by the idle watchdog", async () => {
    deliverOnSend("resp_d");
    const { streamFn, onIdleTimeout, runAbort } = startWatchdog("D");
    const { entered, release, consumed } = parkConsumer(streamFn, runAbort.signal);
    await vi.advanceTimersByTimeAsync(10);
    await entered;
    await expectIdleDeadline(onIdleTimeout);
    expect(String(onIdleTimeout.mock.calls[0]?.[0]?.message)).toMatch(/idle timeout/);
    expect(ControlledWebSocket.instances[0]?.closeCalls.length).toBeGreaterThan(0);

    release();
    await vi.advanceTimersByTimeAsync(10);
    expectStreamFailure(await consumed, /idle timeout|aborted/);
  });

  it.each([
    { activity: "bookkeeping", parked: true },
    { activity: "hidden reasoning", parked: true },
    { activity: "empty reasoning", parked: false },
    { activity: "repeated snapshot", parked: false },
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
      const { entered, release, consumed } = parkConsumer(streamFn, runAbort.signal, parked);
      await vi.advanceTimersByTimeAsync(10);
      await entered;
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
      release();
      await vi.advanceTimersByTimeAsync(10);
      const outcome = await consumed;
      if (activity !== "hidden reasoning") {
        expectStreamFailure(outcome, /no model progress|aborted/);
      } else {
        expect(outcome.thrown).toBeUndefined();
        expect(outcome.result?.stopReason).toBe("stop");
        expect(onIdleTimeout).not.toHaveBeenCalled();
      }
    },
  );
});
