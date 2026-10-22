import { hash } from "node:crypto";
import { responsesPromptObserver } from "@openclaw/ai/internal/openai";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  type Context,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareModelRequestBody } from "../../../packages/ai/src/transports/model-request-body.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import {
  clearProviderPromptState,
  getProviderPromptState,
  markLastProviderPromptContextRejected,
  type ProviderPromptState,
  wrapStreamFnWithProviderPromptState,
} from "./provider-prompt-state.js";

const model = {
  id: "model-1",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
} as Model;
const context: Context = { systemPrompt: "system", messages: [], tools: [] };
let state: ProviderPromptState;
beforeEach(() => {
  state = {};
});

function observe(
  promptState: ProviderPromptState,
  streamFn: StreamFn,
  options: Partial<
    Pick<
      Parameters<typeof wrapStreamFnWithProviderPromptState>[0],
      "recordEvent" | "effectiveContextTokenBudget"
    >
  > = {},
) {
  return wrapStreamFnWithProviderPromptState({
    state: promptState,
    streamFn,
    effectiveContextTokenBudget: 128_000,
    ...options,
  });
}

function createResultStream(
  stopReason: "error" | "stop",
  errorMessage = "context length exceeded",
  stream = createAssistantMessageEventStream(),
) {
  stream.end({
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { ...createZeroUsageFixture(), input: 1, output: 1, totalTokens: 2 },
    stopReason,
    ...(stopReason === "error" ? { errorMessage } : {}),
    timestamp: 1,
  });
  return stream;
}

function payloadTransport(payload: unknown) {
  return vi.fn<StreamFn>(async (_model, _context, options) => {
    await options?.onPayload?.(payload, model);
    return createResultStream("error");
  });
}

describe("provider prompt state", () => {
  it("retains active run state until its owned cleanup", () => {
    const firstRunId = "active-run-0";
    const otherRunIds = Array.from({ length: 79 }, (_, index) => `active-run-${index + 1}`);
    const first = getProviderPromptState(firstRunId);
    try {
      for (const runId of otherRunIds) {
        getProviderPromptState(runId);
      }
      expect(getProviderPromptState(firstRunId)).toBe(first);
      clearProviderPromptState(firstRunId);
      expect(getProviderPromptState(firstRunId)).not.toBe(first);
    } finally {
      for (const runId of [firstRunId, ...otherRunIds]) {
        clearProviderPromptState(runId);
      }
    }
  });

  it("records only bounded private observer evidence", async () => {
    const marker = "PRIVATE-PROVIDER-PROMPT-MARKER";
    const recordEvent = vi.fn();
    const observation = {
      egress: "responses-sdk",
      payloadVariant: "initial",
      promptSource: "input.developer",
      expectedChars: marker.length,
      observedChars: marker.length,
      matchesAssembledPrompt: true,
    } as const;
    const wrapped = observe(
      state,
      async (_model, _context, options) => {
        if (!options) {
          throw new Error("missing stream options");
        }
        await options.onPayload?.({ input: marker }, model);
        responsesPromptObserver.get(options)?.(observation);
        return createResultStream("stop");
      },
      { recordEvent },
    );

    await (await wrapped(model, { ...context, systemPrompt: marker })).result();

    expect(recordEvent).toHaveBeenCalledWith("provider.prompt.observed", observation);
    expect(JSON.stringify({ calls: recordEvent.mock.calls, state })).not.toContain(marker);
    expect(state.lastAttempt?.cachePrefix).toBeUndefined();
  });

  it("records recovery attempts and final response metadata without leaking them to the next call", async () => {
    const onResponse = vi.fn();
    let recover = true;
    const wrapped = observe(state, async (_model, _context, options) => {
      const encode = prepareModelRequestBody(options);
      for (const attempt of recover
        ? (["initial", "continuation-rejected"] as const)
        : (["initial"] as const)) {
        responsesPromptObserver.get(options!)?.({
          egress: "responses-sdk",
          payloadVariant: attempt,
          promptSource: "missing",
          expectedChars: 0,
          observedChars: 0,
          matchesAssembledPrompt: false,
        });
        await encode({ input: [], stream: true });
        await options?.onResponse?.(
          {
            status: attempt === "initial" ? 400 : 200,
            headers: { "x-request-id": attempt, "openai-processing-ms": "private-value" },
          },
          model,
        );
      }
      return createResultStream("stop");
    });
    await wrapped(model, { messages: [] }, { onResponse });
    expect(state.lastAttempt?.wire).toMatchObject({
      cacheKeyPresent: false,
      previousResponseIdPresent: false,
      attempts: 2,
      retried: true,
      egress: "responses-sdk",
      payloadVariant: "continuation-rejected",
      response: {
        status: 200,
        headers: { "x-request-id": hash("sha256", "continuation-rejected").slice(0, 16) },
      },
    });
    expect(state.lastAttempt?.wire?.response?.headers).not.toHaveProperty("openai-processing-ms");
    expect(onResponse).toHaveBeenCalledTimes(2);
    recover = false;
    await wrapped(model, { messages: [] });
    expect(state.lastAttempt?.wire).toMatchObject({
      attempts: 1,
      retried: false,
      payloadVariant: "initial",
    });
  });

  it.each<[string, unknown, string]>([
    [
      "ordinary nested payload",
      { messages: [{ text: "earlier 🦞" }, { text: "tail" }], model: "model-1" },
      '{"messages":[{"text":"earlier 🦞"},{"text":"tail"}],"model":"model-1"}',
    ],
    [
      "non-enumerable array element with metadata",
      Object.defineProperty(Object.assign(["earlier"], { metadata: "fixture" }), "0", {
        enumerable: false,
      }),
      '["earlier"]',
    ],
    [
      "custom hook callback",
      { input: "hello", callback: () => undefined },
      '{"callback":null,"input":"hello"}',
    ],
    [
      "custom error name",
      Object.assign(new Error("fixture"), {
        name: "FixtureError",
        stack: "fixture-stack",
      }),
      '{"message":"fixture","name":"FixtureError","stack":"fixture-stack"}',
    ],
  ])("preserves canonical identity for %s", async (_name, payload, canonical) => {
    const wrapped = observe(state, payloadTransport(payload));
    await wrapped(model, { messages: [] });
    expect(markLastProviderPromptContextRejected(state)).toMatchObject({
      digest: hash("sha256", canonical),
      byteWeight: Buffer.byteLength(canonical),
    });
    await expect(wrapped(model, { messages: [] })).rejects.toThrow(
      "byte-identical provider payload",
    );
  });

  it("does not compare rejected payloads across effective context scopes", async () => {
    const transport = payloadTransport({ input: "same", model: model.id });
    const first = observe(state, transport, { effectiveContextTokenBudget: 64_000 });
    await (await first(model, context)).result();
    markLastProviderPromptContextRejected(state);
    await (await observe(state, transport)(model, context)).result();
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("keeps a rejected primary identity across successful auxiliary attempts", async () => {
    const rejectedPayload = { input: "rejected", model: model.id };
    const successfulPayload = { input: "successful", model: model.id };
    const payloads = [rejectedPayload, successfulPayload, { ...rejectedPayload }];
    const stopReasons: Array<"error" | "stop"> = ["error", "stop"];
    const transport = vi.fn<StreamFn>(async (_model, _context, options) => {
      const payload = payloads.shift();
      await options?.onPayload?.(payload, model);
      return createResultStream(stopReasons.shift() ?? "error");
    });
    const wrapped = observe(state, transport);

    await (await wrapped(model, context)).result();
    markLastProviderPromptContextRejected(state);
    await (await wrapped(model, context)).result();

    await expect(wrapped(model, context)).rejects.toThrow("byte-identical provider payload");
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it("does not invent an identity for a custom transport without onPayload", async () => {
    const observed = observe(state, payloadTransport({ input: "observed" }));
    await (await observed(model, context)).result();
    expect(state.lastAttempt).toBeDefined();

    const stream = createResultStream("error", "connection dropped after dispatch");
    const wrapped = observe(state, () => stream);

    await (await wrapped(model, context)).result();

    expect(state.lastAttempt).toBeUndefined();
    expect(markLastProviderPromptContextRejected(state)).toBeUndefined();
  });

  it("records identity after an asynchronous payload hook finishes", async () => {
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
    const wrapped = observe(state, transport);

    const result = await wrapped(model, context, {
      onPayload: async (payload) => {
        await payloadHookGate;
        return payload;
      },
    });
    expect(state.lastAttempt).toBeUndefined();

    releasePayloadHook?.();
    await observedPayloadHook;
    expect(state.lastAttempt).toBeDefined();

    createResultStream("stop", undefined, stream);
    await result.result();
  });
});
