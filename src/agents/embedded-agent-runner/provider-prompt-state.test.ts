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
import { createDeferred } from "../../../test/helpers/promise.js";
import type { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { prepareProviderPrompt } from "./provider-prompt-serialization.js";
import {
  clearProviderPromptState,
  getProviderPromptState,
  markLastProviderPromptContextRejected,
  type PromptPreparationResult,
  type PromptPreparationTask,
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
  recordEvent?: Parameters<typeof wrapStreamFnWithProviderPromptState>[0]["recordEvent"],
) {
  return wrapStreamFnWithProviderPromptState({
    state: promptState,
    streamFn,
    recordEvent,
    effectiveContextTokenBudget: 128_000,
  });
}

function endResultStream(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  stopReason: "error" | "stop",
  errorMessage = "context length exceeded",
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
}

function createResultStream(stopReason: "error" | "stop", errorMessage?: string) {
  const stream = createAssistantMessageEventStream();
  endResultStream(stream, stopReason, errorMessage);
  return stream;
}

describe("provider prompt state", () => {
  it("keeps state within one run id and drops it at the run boundary", () => {
    const first = getProviderPromptState("run-1");
    expect(getProviderPromptState("run-1")).toBe(first);

    clearProviderPromptState("run-1");
    expect(getProviderPromptState("run-1")).not.toBe(first);
    clearProviderPromptState("run-1");
  });

  it("retains active run state until its owned cleanup", () => {
    const firstRunId = "active-run-0";
    const otherRunIds = Array.from({ length: 79 }, (_, index) => `active-run-${index + 1}`);
    const first = getProviderPromptState(firstRunId);
    try {
      for (const runId of otherRunIds) {
        getProviderPromptState(runId);
      }
      expect(getProviderPromptState(firstRunId)).toBe(first);
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
      recordEvent,
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

  it("observes the final replacement body and blocks its rejected replay before network send", async () => {
    const userContext: Context = {
      ...context,
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    };
    const sentPayloads: unknown[] = [];
    const transport = vi.fn<StreamFn>(async (_model, _context, options) => {
      const rawPayload = { input: "raw", model: model.id };
      const replacement = await options?.onPayload?.(rawPayload, model);
      sentPayloads.push(replacement === undefined ? rawPayload : replacement);
      return createResultStream("error");
    });
    const finalPayload = { input: "final 🦞 日本語".repeat(3_000), model: model.id };
    const wrapped = observe(state, transport);

    await (await wrapped(model, userContext, { onPayload: () => finalPayload })).result();
    markLastProviderPromptContextRejected(state);

    const changedPayload = { input: "changed", model: model.id };
    await (await wrapped(model, userContext, { onPayload: () => changedPayload })).result();

    await expect(
      wrapped(model, userContext, {
        onPayload: () => ({ ...finalPayload }),
      }),
    ).rejects.toThrow("byte-identical provider payload");
    expect(transport).toHaveBeenCalledTimes(3);
    expect(sentPayloads).toEqual([finalPayload, changedPayload]);
    expect(JSON.stringify(state)).not.toContain("final");
  });

  it.each([
    {
      name: "ordinary nested payload",
      payload: { messages: [{ text: "earlier 🦞" }, { text: "tail" }], model: "model-1" },
      canonical: '{"messages":[{"text":"earlier 🦞"},{"text":"tail"}],"model":"model-1"}',
    },
    {
      name: "non-enumerable array element with metadata",
      payload: Object.defineProperty(Object.assign(["earlier"], { metadata: "fixture" }), "0", {
        enumerable: false,
      }),
      canonical: '["earlier"]',
    },
    {
      name: "array with a trailing hole",
      payload: Object.assign(["earlier"], { length: 2 }),
      canonical: '["earlier",undefined]',
    },
    {
      name: "sparse array rejected before inspecting a custom child",
      payload: Object.assign(
        [
          Object.create(
            new Proxy(
              {},
              {
                has() {
                  throw new Error("custom prototype must not be inspected");
                },
              },
            ),
          ),
        ],
        { length: 2 },
      ),
      canonical: "[{},undefined]",
    },
    {
      name: "accessor after ordinary prompt data",
      payload: {
        input: "earlier".repeat(1_000),
        get tail() {
          return "getter value";
        },
      },
      canonical: `{"input":"${"earlier".repeat(1_000)}","tail":"getter value"}`,
    },
    {
      name: "custom hook callback",
      payload: { input: "hello", callback: () => undefined },
      canonical: '{"callback":null,"input":"hello"}',
    },
    {
      name: "custom error name",
      payload: Object.assign(new Error("fixture"), {
        name: "FixtureError",
        stack: "fixture-stack",
      }),
      canonical: '{"message":"fixture","name":"FixtureError","stack":"fixture-stack"}',
    },
  ])("preserves canonical identity for $name", async ({ payload, canonical }) => {
    const wrapped = observe(state, async (_model, _context, options) => {
      await options?.onPayload?.(payload, model);
      return createResultStream("error");
    });
    await wrapped(model, { messages: [] });
    expect(markLastProviderPromptContextRejected(state)).toMatchObject({
      digest: hash("sha256", canonical),
      byteWeight: Buffer.byteLength(canonical),
    });
    await expect(wrapped(model, { messages: [] })).rejects.toThrow(
      "byte-identical provider payload",
    );
  });

  it("admits a large prompt without allocating key-entry iterators", async () => {
    const payload = {
      messages: Array.from({ length: 512 }, () => ({ text: "x".repeat(2048) })),
    };
    const prepared = prepareProviderPrompt({ payload, encode: false });
    const entries = vi.spyOn(Array.prototype, "entries");
    // A prior file can own the pool through an earlier module evaluation;
    // replace only its transport so admission and payload observation stay real.
    const pool = resolveGlobalSingleton<
      WorkerTaskPool<PromptPreparationTask, PromptPreparationResult>
    >(Symbol.for("openclaw.providerPromptHashPool"), () => {
      throw new Error("Expected provider prompt state to initialize its worker pool");
    });
    const worker = vi.spyOn(pool, "run").mockResolvedValueOnce({
      kind: "provider",
      prompt: prepared,
    });
    const wrapped = observe(state, async (_model, _context, options) => {
      await options?.onPayload?.(payload, model);
      return createResultStream("stop");
    });
    try {
      await wrapped(model, context);
      expect(worker).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
        inputBytes: 2_153_412,
        signal: undefined,
      });
      expect(state.lastAttempt?.digest).toBe(prepared.digest);
      expect(entries).not.toHaveBeenCalled();
    } finally {
      worker.mockRestore();
      entries.mockRestore();
    }
  });

  it("does not compare rejected payloads across effective context scopes", async () => {
    const runId = "changed-context-scope";
    const scopedState = getProviderPromptState(runId);
    const scopedContext = { systemPrompt: "system", messages: [], tools: [] } as Context;
    const payload = { input: "same", model: model.id };
    const transport = vi.fn<StreamFn>(async (_model, _context, options) => {
      await options?.onPayload?.(payload, model);
      return createResultStream("error");
    });
    const firstWrapped = wrapStreamFnWithProviderPromptState({
      streamFn: transport,
      state: scopedState,
      effectiveContextTokenBudget: 64_000,
    });
    const first = await firstWrapped(model, scopedContext);
    await first.result();
    markLastProviderPromptContextRejected(scopedState);

    const secondWrapped = wrapStreamFnWithProviderPromptState({
      streamFn: transport,
      state: scopedState,
      effectiveContextTokenBudget: 128_000,
    });
    const second = await secondWrapped(model, scopedContext);
    await second.result();

    expect(transport).toHaveBeenCalledTimes(2);
    clearProviderPromptState(runId);
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
    const observed = observe(state, async (_model, _context, options) => {
      await options?.onPayload?.({ input: "observed" }, model);
      return createResultStream("error");
    });
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
    const { promise: payloadHookGate, resolve: releasePayloadHook } = createDeferred();
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

    endResultStream(stream, "stop");
    await result.result();
  });
});
