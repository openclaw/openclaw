import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  type Context,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import {
  assertProviderPromptRetryProgress,
  beginProviderPromptAttempt,
  clearProviderPromptState,
  createProviderPromptState,
  getProviderPromptState,
  markLastProviderPromptContextRejected,
  markProviderPromptSucceeded,
  ProviderPromptRetryNoProgressError,
  recordProviderPromptAttempt,
  snapshotProviderPrompt,
  wrapStreamFnWithProviderPromptState,
} from "./provider-prompt-state.js";

const model = {
  id: "model-1",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
} as Model;

function snapshot(text: string, effectiveContextTokenBudget = 128_000) {
  return snapshotProviderPrompt({
    model,
    effectiveContextTokenBudget,
    payload: { input: text, model: model.id },
  });
}

describe("provider prompt state", () => {
  it("keeps state within one run id and drops it at the run boundary", () => {
    const first = getProviderPromptState("run-1");
    first.lastAttempt = snapshot("hello");
    expect(getProviderPromptState("run-1")).toBe(first);

    clearProviderPromptState("run-1");
    expect(getProviderPromptState("run-1")).not.toBe(first);
    clearProviderPromptState("run-1");
  });

  it("retains active run state until its owned cleanup", () => {
    const firstRunId = "active-run-0";
    const otherRunIds = Array.from({ length: 79 }, (_, index) => `active-run-${index + 1}`);
    const first = getProviderPromptState(firstRunId);
    for (const runId of otherRunIds) {
      getProviderPromptState(runId);
    }

    expect(getProviderPromptState(firstRunId)).toBe(first);
    for (const runId of [firstRunId, ...otherRunIds]) {
      clearProviderPromptState(runId);
    }
  });

  it("builds a stable final-payload identity without retaining payload content", () => {
    const first = snapshot("hello");
    const second = snapshot("hello");
    const changed = snapshot("hello again");

    expect(first).toEqual(second);
    expect(changed.digest).not.toBe(first.digest);
    expect(Object.values(first)).not.toContain("hello");
  });

  it("allows any changed payload and rejects only an exact retry", () => {
    const state = createProviderPromptState();
    const rejected = snapshot("x".repeat(1_000));

    expect(() => assertProviderPromptRetryProgress(state, rejected)).not.toThrow();
    recordProviderPromptAttempt(state, rejected);
    expect(markLastProviderPromptContextRejected(state)).toEqual(rejected);

    expect(() => assertProviderPromptRetryProgress(state, rejected)).toThrow(
      ProviderPromptRetryNoProgressError,
    );
    expect(() =>
      assertProviderPromptRetryProgress(state, snapshot("y".repeat(1_000))),
    ).not.toThrow();
    expect(() =>
      assertProviderPromptRetryProgress(state, snapshot("z".repeat(2_000))),
    ).not.toThrow();
    expect(() => assertProviderPromptRetryProgress(state, snapshot("short"))).not.toThrow();
  });

  it("clears the current attempt before a transport without payload observation", () => {
    const state = createProviderPromptState();
    const attempted = snapshot("hello");
    recordProviderPromptAttempt(state, attempted);

    beginProviderPromptAttempt(state);

    expect(markLastProviderPromptContextRejected(state)).toBeUndefined();
  });

  it("does not compare rejections across a changed effective context scope", () => {
    const state = createProviderPromptState();
    const rejected = snapshot("x".repeat(1_000), 64_000);
    recordProviderPromptAttempt(state, rejected);
    markLastProviderPromptContextRejected(state);

    expect(() =>
      assertProviderPromptRetryProgress(state, snapshot("x".repeat(1_000), 128_000)),
    ).not.toThrow();
  });

  it("clears rejection state only after the matching provider attempt succeeds", () => {
    const state = createProviderPromptState();
    const rejected = snapshot("x".repeat(1_000));
    const smaller = snapshot("short");
    recordProviderPromptAttempt(state, rejected);
    markLastProviderPromptContextRejected(state);
    recordProviderPromptAttempt(state, smaller);

    markProviderPromptSucceeded(state, rejected);
    expect(state.lastRejected).toEqual(rejected);
    markProviderPromptSucceeded(state, smaller);
    expect(state.lastRejected).toBeUndefined();
    expect(state.lastAttempt).toBeUndefined();
    expect(markLastProviderPromptContextRejected(state)).toBeUndefined();
  });

  it("observes the final replacement body and blocks its rejected replay before network send", async () => {
    const state = createProviderPromptState();
    const context = {
      systemPrompt: "system",
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
      tools: [],
    } as Context;
    const sentPayloads: unknown[] = [];
    const transport = vi.fn<StreamFn>(async (_model, _context, options) => {
      const rawPayload = { input: "raw", model: model.id };
      const replacement = await options?.onPayload?.(rawPayload, model);
      sentPayloads.push(replacement === undefined ? rawPayload : replacement);
      const stream = createAssistantMessageEventStream();
      stream.end({
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: "context length exceeded",
        timestamp: 1,
      });
      return stream;
    });
    const finalPayload = { input: "final", model: model.id };
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: transport,
      state,
      effectiveContextTokenBudget: 128_000,
    });

    const first = await wrapped(model, context, {
      onPayload: () => finalPayload,
    });
    await first.result();
    markLastProviderPromptContextRejected(state);

    await expect(
      wrapped(model, context, {
        onPayload: () => ({ ...finalPayload }),
      }),
    ).rejects.toThrow("byte-identical provider payload");
    expect(transport).toHaveBeenCalledTimes(2);
    expect(sentPayloads).toEqual([finalPayload]);
  });

  it("does not invent an identity for a custom transport without onPayload", async () => {
    const state = createProviderPromptState();
    const stream = createAssistantMessageEventStream();
    stream.end({
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: "connection dropped after dispatch",
      timestamp: 1,
    });
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: () => stream,
      state,
      effectiveContextTokenBudget: 128_000,
    });

    const result = await wrapped(model, {
      systemPrompt: "system",
      messages: [],
      tools: [],
    });
    await result.result();

    expect(state.lastAttempt).toBeUndefined();
  });

  it("records identity after an asynchronous payload hook finishes", async () => {
    const state = createProviderPromptState();
    const stream = createAssistantMessageEventStream();
    let releasePayloadHook: (() => void) | undefined;
    const payloadHookGate = new Promise<void>((resolve) => {
      releasePayloadHook = resolve;
    });
    let observedPayloadHook: Promise<unknown> | undefined;
    const transport = vi.fn<StreamFn>((_model, _context, options) => {
      observedPayloadHook = options?.onPayload?.({ input: "hello" }, model) as Promise<unknown>;
      return stream;
    });
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: transport,
      state,
      effectiveContextTokenBudget: 128_000,
    });

    const result = await wrapped(
      model,
      { systemPrompt: "system", messages: [], tools: [] },
      {
        onPayload: async (payload) => {
          await payloadHookGate;
          return payload;
        },
      },
    );
    expect(state.lastAttempt).toBeUndefined();

    releasePayloadHook?.();
    await observedPayloadHook;
    expect(state.lastAttempt).toBeDefined();

    stream.end({
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    });
    await result.result();
  });
});
