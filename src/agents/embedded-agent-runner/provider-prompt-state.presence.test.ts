import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { createResponsesPromptEgressObserver } from "../../../packages/ai/src/transports/openai-responses-prompt-observer-internal.js";
import {
  promptPresenceExpectations,
  type PromptPresenceCheck,
} from "../../../packages/ai/src/transports/prompt-presence-check.js";
import {
  clearProviderPromptState,
  getProviderPromptState,
  wrapStreamFnWithProviderPromptState,
} from "./provider-prompt-state.js";

const model = {
  id: "model-1",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
} as Model;

const BODY = "产出闭环验证：交付前必须以可观察证据校验产物新鲜度与正确性";

function expectation(activationId: string, bodyComplete = true) {
  return {
    activationId,
    revision: 0,
    bodyText: BODY,
    bodyChars: BODY.length,
    bodyComplete,
  };
}

function createResultStream() {
  const stream = createAssistantMessageEventStream();
  stream.end({
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 1, output: 1, totalTokens: 2 },
    stopReason: "stop",
    timestamp: 1,
  });
  return stream;
}

type RecordedEvent = {
  requestIndex?: number;
  presenceCheck?: PromptPresenceCheck;
  promptSource?: string;
  egress?: string;
};

describe("provider prompt state presence wiring (defect-2 semantics)", () => {
  it("same production wrapper, two consecutive logical requests: requestIndex 1 then 2 (no manual counter bumps)", async () => {
    const runId = "presence-bind";
    const state = getProviderPromptState(runId);
    state.pendingInjectedExpectations = [expectation("act_prompt_target")];
    const recordEvent = vi.fn();
    const requestIndexes: number[] = [];
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: (async (_model, context, options) => {
        const observePrompt = createResponsesPromptEgressObserver(options, context.systemPrompt);
        observePrompt?.(
          { instructions: context.systemPrompt, input: [{ role: "user", content: "hi" }] },
          { egress: "responses-sdk", payloadVariant: "initial" },
        );
        requestIndexes.push(
          (recordEvent.mock.calls.at(-1)?.[1] as RecordedEvent).requestIndex ?? -1,
        );
        return createResultStream();
      }) as StreamFn,
      state,
      effectiveContextTokenBudget: 128_000,
      recordEvent,
    });
    const first = await wrapped(model, { systemPrompt: BODY, messages: [], tools: [] }, undefined);
    await first.result();
    const second = await wrapped(model, { systemPrompt: BODY, messages: [], tools: [] }, undefined);
    await second.result();
    expect(requestIndexes).toEqual([1, 2]);
    const call = recordEvent.mock.calls[0]?.[1] as RecordedEvent;
    expect(call.presenceCheck?.checked).toBe(true);
    expect(call.presenceCheck?.results[0]).toMatchObject({
      activationId: "act_prompt_target",
      outcome: "full_hit",
    });
    clearProviderPromptState(runId);
  });

  it("stacked wrapper layers (per-attempt re-wrap) count once per invocation", async () => {
    const runId = "presence-stack";
    const state = getProviderPromptState(runId);
    state.pendingInjectedExpectations = [expectation("act_stack")];
    const recordEvent = vi.fn();
    const makeLayer = (inner: StreamFn): StreamFn =>
      wrapStreamFnWithProviderPromptState({
        streamFn: inner,
        state,
        effectiveContextTokenBudget: 128_000,
        recordEvent,
      });
    // Simulate two attempt re-wraps: outermost wraps an already-wrapped fn.
    const base: StreamFn = (async (_model, context, options) => {
      const observePrompt = createResponsesPromptEgressObserver(options, context.systemPrompt);
      observePrompt?.(
        { instructions: context.systemPrompt, input: [] },
        { egress: "responses-sdk", payloadVariant: "initial" },
      );
      return createResultStream();
    }) as StreamFn;
    const mid = makeLayer(base);
    const outer = makeLayer(mid);
    // One invocation through the chain must yield exactly ONE logical request.
    (await outer(model, { systemPrompt: "s", messages: [], tools: [] }, undefined)).result();
    const indexes = recordEvent.mock.calls.map((c) => (c[1] as RecordedEvent).requestIndex);
    // Only the outermost layer's observer survives the final options; inner
    // layers never emit, so exactly one event per invocation, requestIndex 1.
    expect(indexes).toHaveLength(1);
    expect(indexes[0]).toBe(1);
    // A second invocation increments exactly once more.
    (await outer(model, { systemPrompt: "s", messages: [], tools: [] }, undefined)).result();
    const secondIndexes = recordEvent.mock.calls.map((c) => (c[1] as RecordedEvent).requestIndex);
    expect(secondIndexes).toEqual([1, 2]);
    clearProviderPromptState(runId);
  });

  it("retry inside one logical request: same requestIndex, attemptIndex 0 then 1", async () => {
    const runId = "presence-retry";
    const state = getProviderPromptState(runId);
    state.pendingInjectedExpectations = [expectation("act_retry", true)];
    const recordEvent = vi.fn();
    const attempts: number[] = [];
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: (async (_model, context, options) => {
        const observePrompt = createResponsesPromptEgressObserver(options, context.systemPrompt);
        for (const payloadVariant of ["initial", "continuation-rejected"] as const) {
          observePrompt?.(
            { instructions: `no body ${payloadVariant}`, input: [] },
            { egress: "responses-sdk", payloadVariant },
          );
          const event = recordEvent.mock.calls.at(-1)?.[1] as RecordedEvent;
          attempts.push(event.presenceCheck?.attemptIndex ?? -1);
        }
        return createResultStream();
      }) as StreamFn,
      state,
      effectiveContextTokenBudget: 128_000,
      recordEvent,
    });
    (await wrapped(model, { systemPrompt: "s", messages: [], tools: [] }, undefined)).result();
    expect(attempts).toEqual([0, 1]);
    const indexes = recordEvent.mock.calls.map((c) => (c[1] as RecordedEvent).requestIndex);
    expect(indexes).toEqual([1, 1]);
    clearProviderPromptState(runId);
  });

  it("concurrent runs do not share expectation sets or request ordinals", async () => {
    const stateOne = getProviderPromptState("presence-conc-1");
    const stateTwo = getProviderPromptState("presence-conc-2");
    stateOne.pendingInjectedExpectations = [expectation("act_run1")];
    stateTwo.pendingInjectedExpectations = [expectation("act_run2")];
    const seen: (string | undefined)[] = [];
    const makeWrapped = (state: ReturnType<typeof getProviderPromptState>) =>
      wrapStreamFnWithProviderPromptState({
        streamFn: (async (_model, _context, options) => {
          seen.push(promptPresenceExpectations.get(options)?.expectations[0]?.activationId);
          return createResultStream();
        }) as StreamFn,
        state,
        effectiveContextTokenBudget: 128_000,
      });
    const wrappedOne = makeWrapped(stateOne);
    const wrappedTwo = makeWrapped(stateTwo);
    await Promise.all([
      wrappedOne(model, { systemPrompt: "1", messages: [], tools: [] }, undefined).then((r) =>
        r.result(),
      ),
      wrappedTwo(model, { systemPrompt: "2", messages: [], tools: [] }, undefined).then((r) =>
        r.result(),
      ),
    ]);
    expect(seen.sort()).toEqual(["act_run1", "act_run2"]);
    clearProviderPromptState("presence-conc-1");
    clearProviderPromptState("presence-conc-2");
  });

  it("second model request after tools reuses the same assembly snapshot; ordinals advance", async () => {
    const runId = "presence-tools";
    const state = getProviderPromptState(runId);
    // One assembly froze the snapshot; two model requests run against it.
    state.pendingInjectedExpectations = [expectation("act_after_tools")];
    const recordEvent = vi.fn();
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: (async (_model, context, options) => {
        const observePrompt = createResponsesPromptEgressObserver(options, context.systemPrompt);
        observePrompt?.(
          { instructions: context.systemPrompt, input: [] },
          { egress: "responses-sdk", payloadVariant: "initial" },
        );
        return createResultStream();
      }) as StreamFn,
      state,
      effectiveContextTokenBudget: 128_000,
      recordEvent,
    });
    (await wrapped(model, { systemPrompt: BODY, messages: [], tools: [] }, undefined)).result();
    (await wrapped(model, { systemPrompt: BODY, messages: [], tools: [] }, undefined)).result();
    const indexes = recordEvent.mock.calls.map((c) => (c[1] as RecordedEvent).requestIndex);
    expect(indexes).toEqual([1, 2]);
    // Both requests observed the SAME frozen snapshot (no cross-run or drift).
    for (const call of recordEvent.mock.calls) {
      const event = call[1] as RecordedEvent;
      expect(event.presenceCheck?.results[0]?.activationId).toBe("act_after_tools");
    }
    clearProviderPromptState(runId);
  });

  it("truncated assembly: carrier entry with bodyComplete=false yields unknown, never full_hit", async () => {
    const runId = "presence-truncated";
    const state = getProviderPromptState(runId);
    state.pendingInjectedExpectations = [expectation("act_truncated", false)];
    const recordEvent = vi.fn();
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: (async (_model, context, options) => {
        const observePrompt = createResponsesPromptEgressObserver(options, context.systemPrompt);
        observePrompt?.(
          { instructions: BODY.slice(0, 20), input: [] },
          { egress: "responses-sdk", payloadVariant: "initial" },
        );
        return createResultStream();
      }) as StreamFn,
      state,
      effectiveContextTokenBudget: 128_000,
      recordEvent,
    });
    (
      await wrapped(model, { systemPrompt: BODY.slice(0, 20), messages: [], tools: [] }, undefined)
    ).result();
    const call = recordEvent.mock.calls[0]?.[1] as RecordedEvent;
    expect(call.presenceCheck?.results[0]).toMatchObject({
      outcome: "unknown",
      reason: "assembly_truncated",
    });
    clearProviderPromptState(runId);
  });

  it("absent expectations: no carrier, no presenceCheck field (normal tasks unaffected)", async () => {
    const runId = "presence-none";
    const state = getProviderPromptState(runId);
    const recordEvent = vi.fn();
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: (async (_model, _context, options) => {
        expect(promptPresenceExpectations.get(options)).toBeUndefined();
        const observePrompt = createResponsesPromptEgressObserver(options, "");
        observePrompt?.(
          { instructions: "plain", input: [] },
          { egress: "responses-sdk", payloadVariant: "initial" },
        );
        return createResultStream();
      }) as StreamFn,
      state,
      effectiveContextTokenBudget: 128_000,
      recordEvent,
    });
    (await wrapped(model, { systemPrompt: "", messages: [], tools: [] }, undefined)).result();
    const call = recordEvent.mock.calls[0]?.[1] as RecordedEvent;
    expect(call.presenceCheck).toBeUndefined();
    // Ordinal still assigned (identity exists even without expectations).
    expect(call.requestIndex).toBe(1);
    clearProviderPromptState(runId);
  });
});
