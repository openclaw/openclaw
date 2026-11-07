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

describe("provider prompt state presence wiring", () => {
  it("binds the attempt's frozen expectations to the request options; event carries presenceCheck + requestIndex", async () => {
    const runId = "presence-bind";
    const state = getProviderPromptState(runId);
    state.requestCount = 1;
    state.pendingInjectedExpectations = [expectation("act_prompt_target")];
    let seenExpectations: readonly unknown[] | undefined;
    const recordEvent = vi.fn();
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: async (_model, context, options) => {
        seenExpectations = promptPresenceExpectations.get(options);
        // Real transport chain: the factory reads the carrier from options and
        // computes presenceCheck before invoking the runner's observer.
        const observePrompt = createResponsesPromptEgressObserver(options, context.systemPrompt);
        observePrompt?.(
          { instructions: context.systemPrompt, input: [{ role: "user", content: "hi" }] },
          { egress: "responses-sdk", payloadVariant: "initial" },
        );
        return createResultStream();
      },
      state,
      effectiveContextTokenBudget: 128_000,
      recordEvent,
    });
    const result = await wrapped(model, { systemPrompt: BODY, messages: [], tools: [] });
    await result.result();
    expect(seenExpectations).toEqual([expectation("act_prompt_target")]);
    const call = recordEvent.mock.calls[0]?.[1] as RecordedEvent;
    expect(call.requestIndex).toBe(1);
    expect(call.presenceCheck?.checked).toBe(true);
    expect(call.presenceCheck?.results[0]).toMatchObject({
      activationId: "act_prompt_target",
      outcome: "full_hit",
    });
    clearProviderPromptState(runId);
  });

  it("same run, second model request: independent expectation sets and increasing requestIndex", async () => {
    const runId = "presence-multi";
    const state = getProviderPromptState(runId);
    const recordEvent = vi.fn();
    const wrappedFor = () =>
      wrapStreamFnWithProviderPromptState({
        streamFn: async (_model, context, options) => {
          const observePrompt = createResponsesPromptEgressObserver(options, context.systemPrompt);
          observePrompt?.(
            { instructions: context.systemPrompt, input: [] },
            { egress: "responses-sdk", payloadVariant: "initial" },
          );
          return createResultStream();
        },
        state,
        effectiveContextTokenBudget: 128_000,
        recordEvent,
      });
    // Attempt 1: assembly freezes expectations A and bumps requestCount.
    state.pendingInjectedExpectations = [expectation("act_A")];
    state.requestCount = (state.requestCount ?? 0) + 1;
    (
      await wrappedFor()(model, { systemPrompt: "text without body A", messages: [], tools: [] })
    ).result();
    // Attempt 2: assembly freezes expectations B and bumps requestCount.
    state.pendingInjectedExpectations = [expectation("act_B")];
    state.requestCount = (state.requestCount ?? 0) + 1;
    (
      await wrappedFor()(model, { systemPrompt: "text without body B", messages: [], tools: [] })
    ).result();
    const first = recordEvent.mock.calls[0]?.[1] as RecordedEvent;
    const second = recordEvent.mock.calls[1]?.[1] as RecordedEvent;
    expect(first.requestIndex).toBe(1);
    expect(second.requestIndex).toBe(2);
    expect(first.presenceCheck?.results[0]?.activationId).toBe("act_A");
    expect(second.presenceCheck?.results[0]?.activationId).toBe("act_B");
    clearProviderPromptState(runId);
  });

  it("concurrent runs do not share expectation sets (no cross-run串用)", async () => {
    const stateOne = getProviderPromptState("presence-conc-1");
    const stateTwo = getProviderPromptState("presence-conc-2");
    stateOne.pendingInjectedExpectations = [expectation("act_run1")];
    stateTwo.pendingInjectedExpectations = [expectation("act_run2")];
    const seen: (string | undefined)[] = [];
    const makeWrapped = (state: ReturnType<typeof getProviderPromptState>) =>
      wrapStreamFnWithProviderPromptState({
        streamFn: async (_model, _context, options) => {
          seen.push(promptPresenceExpectations.get(options)?.[0]?.activationId);
          return createResultStream();
        },
        state,
        effectiveContextTokenBudget: 128_000,
      });
    const wrappedOne = makeWrapped(stateOne);
    const wrappedTwo = makeWrapped(stateTwo);
    await Promise.all([
      wrappedOne(model, { systemPrompt: "1", messages: [], tools: [] }).then((r) => r.result()),
      wrappedTwo(model, { systemPrompt: "2", messages: [], tools: [] }).then((r) => r.result()),
    ]);
    expect(seen.sort()).toEqual(["act_run1", "act_run2"]);
    clearProviderPromptState("presence-conc-1");
    clearProviderPromptState("presence-conc-2");
  });

  it("absent expectations: no carrier set, events stay untouched (normal tasks unaffected)", async () => {
    const runId = "presence-none";
    const state = getProviderPromptState(runId);
    const recordEvent = vi.fn();
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: async (_model, _context, options) => {
        expect(promptPresenceExpectations.get(options)).toBeUndefined();
        const observePrompt = createResponsesPromptEgressObserver(options, "");
        observePrompt?.(
          { instructions: "plain", input: [] },
          { egress: "responses-sdk", payloadVariant: "initial" },
        );
        return createResultStream();
      },
      state,
      effectiveContextTokenBudget: 128_000,
      recordEvent,
    });
    (await wrapped(model, { systemPrompt: "", messages: [], tools: [] })).result();
    const call = recordEvent.mock.calls[0]?.[1] as RecordedEvent;
    expect(call.requestIndex).toBeUndefined();
    expect(call.presenceCheck).toBeUndefined();
    clearProviderPromptState(runId);
  });

  it("truncated assembly: carrier entry with bodyComplete=false yields unknown, never full_hit", async () => {
    const runId = "presence-truncated";
    const state = getProviderPromptState(runId);
    state.requestCount = 1;
    state.pendingInjectedExpectations = [expectation("act_truncated", false)];
    const recordEvent = vi.fn();
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: async (_model, context, options) => {
        // The wire contains only the truncated fragment (what assembly produced).
        const observePrompt = createResponsesPromptEgressObserver(options, context.systemPrompt);
        observePrompt?.(
          { instructions: BODY.slice(0, 20), input: [] },
          { egress: "responses-sdk", payloadVariant: "initial" },
        );
        return createResultStream();
      },
      state,
      effectiveContextTokenBudget: 128_000,
      recordEvent,
    });
    (await wrapped(model, { systemPrompt: BODY.slice(0, 20), messages: [], tools: [] })).result();
    const call = recordEvent.mock.calls[0]?.[1] as RecordedEvent;
    expect(call.presenceCheck?.results[0]).toMatchObject({
      outcome: "unknown",
      reason: "assembly_truncated",
    });
    clearProviderPromptState(runId);
  });

  it("retry: attemptIndex increments per transport attempt inside one logical request", async () => {
    const runId = "presence-retry";
    const state = getProviderPromptState(runId);
    state.requestCount = 1;
    state.pendingInjectedExpectations = [expectation("act_retry", true)];
    const recordEvent = vi.fn();
    const indices: number[] = [];
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: async (_model, context, options) => {
        const observePrompt = createResponsesPromptEgressObserver(options, context.systemPrompt);
        // Two transport attempts inside one logical request (retry after rejection).
        for (const payloadVariant of ["initial", "continuation-rejected"] as const) {
          observePrompt?.(
            { instructions: `no body ${payloadVariant}`, input: [] },
            { egress: "responses-sdk", payloadVariant },
          );
          indices.push(
            (recordEvent.mock.calls.at(-1)?.[1] as RecordedEvent).presenceCheck?.attemptIndex ?? -1,
          );
        }
        return createResultStream();
      },
      state,
      effectiveContextTokenBudget: 128_000,
      recordEvent,
    });
    (await wrapped(model, { systemPrompt: "s", messages: [], tools: [] })).result();
    expect(indices).toEqual([0, 1]);
    // Same requestIndex across both attempts (one logical request).
    const first = recordEvent.mock.calls[0]?.[1] as RecordedEvent;
    const second = recordEvent.mock.calls[1]?.[1] as RecordedEvent;
    expect(first.requestIndex).toBe(1);
    expect(second.requestIndex).toBe(1);
    clearProviderPromptState(runId);
  });
});
