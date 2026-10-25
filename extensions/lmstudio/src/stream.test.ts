import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createAssistantMessageEventStream, type AssistantMessage } from "openclaw/plugin-sdk/llm";
import { NON_ENV_SECRETREF_MARKER } from "openclaw/plugin-sdk/provider-auth-runtime";
import { createZeroUsageFixture } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelProviderConfig } from "../../test-support/model-provider-config.test-support.js";
import { LmstudioModelLoadError } from "./models.fetch.js";

let wrapLmstudioInferencePreload: typeof import("./stream.js").wrapLmstudioInferencePreload;
let defaultBaseUrl: string;
let defaultBaseUrlSequence = 0;

const prepareModel = vi.hoisted(() => vi.fn());
const resolveHeaders = vi.hoisted(() => vi.fn(async (_params?: unknown) => undefined));
const resolveApiKey = vi.hoisted(() =>
  vi.fn(async (_params?: unknown): Promise<string | undefined> => undefined),
);

vi.mock("./models.fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./models.fetch.js")>()),
  prepareLmstudioModelForInference: (params: unknown) => prepareModel(params),
}));

vi.mock("./runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime.js")>()),
  resolveLmstudioProviderHeaders: (params: unknown) => resolveHeaders(params),
  resolveLmstudioRuntimeApiKey: (params: unknown) => resolveApiKey(params),
}));

beforeAll(async () => {
  ({ wrapLmstudioInferencePreload } = await import("./stream.js"));
});

type StreamEvent = { type: string } & Record<string, unknown>;

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant" as const,
    content,
    api: "openai-completions" as const,
    provider: "lmstudio",
    model: "qwen3-8b-instruct",
    usage: createZeroUsageFixture(),
    stopReason: "stop" as const,
    timestamp: 1,
  };
}

function expectDone(events: StreamEvent[]) {
  expect(events).toEqual([expect.objectContaining({ type: "done" })]);
}

function expectPreload(fields: Record<string, unknown>) {
  expect(prepareModel.mock.calls[0]?.[0]).toMatchObject(fields);
}

function expectModel(baseStream: StreamFn, fields: Record<string, unknown>) {
  const call = vi.mocked(baseStream).mock.calls[0];
  expect(call?.[0]).toMatchObject(fields);
  expect(call?.[1]).toBeDefined();
  expect(call).toBeDefined();
  expect(call?.[2]).toBeUndefined();
}

function expectModelCall(baseStream: StreamFn, callIndex: number, fields: Record<string, unknown>) {
  expect(vi.mocked(baseStream).mock.calls[callIndex]?.[0]).toMatchObject(fields);
}

async function collectEvents(stream: ReturnType<StreamFn>): Promise<StreamEvent[]> {
  const resolved = stream instanceof Promise ? await stream : stream;
  const events: StreamEvent[] = [];
  for await (const event of resolved) {
    events.push(event as StreamEvent);
  }
  return events;
}

function doneStream(): StreamFn {
  return eventStream([{ type: "done", reason: "stop", message: assistantMessage([]) }]);
}

function eventStream(events: unknown[]): StreamFn {
  return vi.fn((_model, _context, _options) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      for (const event of events) {
        stream.push(event as never);
      }
      stream.end();
    });
    return stream;
  });
}

function wrap(
  baseStream: StreamFn,
  params?: { baseUrl?: string; thinkingLevel?: string; preload?: false },
): StreamFn {
  return wrapLmstudioInferencePreload({
    provider: "lmstudio",
    modelId: "qwen3-8b-instruct",
    config: createModelProviderConfig({
      lmstudio: {
        baseUrl: params?.baseUrl ?? defaultBaseUrl,
        ...(params?.preload === false ? { params: { preload: false } } : {}),
        models: [],
      },
    }),
    streamFn: baseStream,
    thinkingLevel: params?.thinkingLevel,
  } as never);
}

function payloadStream(payload: Record<string, unknown>): StreamFn {
  return vi.fn((model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      options?.onPayload?.(payload, model);
      stream.push({ type: "done", reason: "stop", message: {} as never });
      stream.end();
    });
    return stream;
  });
}

const BINARY_REASONING_COMPAT = {
  supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
  reasoningEffortMap: { off: "none", none: "none", adaptive: "xhigh", max: "xhigh" },
};

function infer(
  wrapped: StreamFn,
  model: Record<string, unknown>,
  options?: Record<string, unknown>,
  context?: Record<string, unknown>,
) {
  return wrapped(
    {
      provider: "lmstudio",
      api: "openai-completions",
      id: "lmstudio/qwen3-8b-instruct",
      ...model,
    } as never,
    { messages: [], ...context } as never,
    options as never,
  );
}

type HeldPreloadScenario = {
  baseStream: StreamFn;
  first: Promise<StreamEvent[]>;
  second: Promise<StreamEvent[]>;
  release: () => void;
  waitFor: <T>(promise: Promise<T>) => Promise<T>;
  assertActive: () => void;
};

let finishHeldPreloadScenario: (() => Promise<void>) | undefined;

function runHeldPreloadScenario(
  run: (held: HeldPreloadScenario) => Promise<void>,
  firstSignal?: AbortSignal,
): Promise<void> {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const cancelled = createDeferred<never>();
  const stopped = new Error("LM Studio preload scenario ended");
  let active = true;
  const pending: Promise<unknown>[] = [Promise.allSettled([cancelled.promise])];
  const assertActive = () => {
    if (!active) {
      throw stopped;
    }
  };
  const waitFor = <T>(promise: Promise<T>): Promise<T> => {
    assertActive();
    const controlled = Promise.race([promise, cancelled.promise]);
    pending.push(Promise.allSettled([controlled]));
    return controlled;
  };

  prepareModel.mockImplementationOnce(() => {
    entered.resolve();
    return release.promise;
  });
  const baseStream = doneStream();
  const wrapped = wrap(baseStream);
  const first = Promise.resolve().then(() =>
    collectEvents(
      infer(wrapped, { contextWindow: 32_768 }, firstSignal ? { signal: firstSignal } : undefined),
    ),
  );
  // This signal-free collector drains the real shared preload, including its
  // in-flight cleanup, even when the scenario or the first caller is cancelled.
  const second = Promise.resolve().then(() =>
    collectEvents(infer(wrapped, { contextWindow: 32_768 })),
  );
  pending.push(Promise.allSettled([first, second]));
  const prematureCompletion = () => {
    throw new Error("LM Studio inference completed before preload entry");
  };
  const admission = waitFor(
    Promise.race([
      entered.promise,
      first.then(prematureCompletion),
      second.then(prematureCompletion),
    ]),
  );
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      active = false;
      cancelled.reject(stopped);
      release.resolve();
      await Promise.all(pending);
    })();
    return cleanupPromise;
  };
  const scenario = Promise.resolve().then(async () => {
    try {
      await admission;
      assertActive();
      await run({ baseStream, first, second, release: release.resolve, waitFor, assertActive });
    } finally {
      await cleanup();
    }
  });
  const settled = Promise.allSettled([scenario]);
  // Vitest can time out before this body settles. Keep its join separate from
  // resource cleanup so the body's finally never waits for itself.
  finishHeldPreloadScenario = async () => {
    await cleanup();
    await settled;
  };
  return scenario;
}

describe("lmstudio stream wrapper", () => {
  beforeEach(() => {
    // Give tests distinct endpoint scope while preserving within-test cache reuse.
    defaultBaseUrl = `http://lmstudio-test-${defaultBaseUrlSequence++}.localhost:1234`;
    prepareModel.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await finishHeldPreloadScenario?.();
    finishHeldPreloadScenario = undefined;
    vi.restoreAllMocks();
    prepareModel.mockReset();
    resolveHeaders.mockReset();
    resolveApiKey.mockReset();
    resolveHeaders.mockResolvedValue(undefined);
    resolveApiKey.mockResolvedValue(undefined);
  });

  it("preloads LM Studio model before inference using model context window", async () => {
    const baseStream = doneStream();
    const wrapped = wrap(baseStream, {
      baseUrl: "http://lmstudio.internal:1234/v1",
    });
    const stream = infer(wrapped, { contextWindow: 131072 }, { apiKey: "lmstudio-token" });
    const events = await collectEvents(stream);

    expectDone(events);
    expect(prepareModel).toHaveBeenCalledTimes(1);
    expectPreload({
      baseUrl: "http://lmstudio.internal:1234/v1",
      modelKey: "qwen3-8b-instruct",
      requestedContextLength: 131072,
      apiKey: "lmstudio-token",
    });
    expectModel(baseStream, {
      compat: { supportsUsageInStreaming: true, unsupportedToolSchemaKeywords: ["pattern"] },
    });
  });

  it("resolves native preload credentials when runtime auth is a non-secret marker", async () => {
    resolveApiKey.mockResolvedValueOnce("synthetic-configured-key");
    const wrapped = wrap(doneStream());
    await collectEvents(infer(wrapped, {}, { apiKey: NON_ENV_SECRETREF_MARKER }));
    expectPreload({ apiKey: "synthetic-configured-key" });
  });

  it("streams with the canonical model key returned by preload", async () => {
    prepareModel.mockResolvedValueOnce({
      modelKey: "gemma-4-e4b-it-ultra-uncensored-heretic",
    });
    const baseStream = doneStream();
    const wrapped = wrap(baseStream);
    const variantKey = "gemma-4-e4b-it-ultra-uncensored-heretic@q4_k_m";
    const stream = infer(wrapped, { id: `lmstudio/${variantKey}` });
    const events = await collectEvents(stream);

    expectDone(events);
    expectPreload({
      modelKey: variantKey,
      baseUrl: `${defaultBaseUrl}/v1`,
    });
    expectModel(baseStream, {
      provider: "lmstudio",
      id: "gemma-4-e4b-it-ultra-uncensored-heretic",
    });
  });

  it("reuses the canonical model key while preload failure cooldown is active", async () => {
    const canonicalKey = "gemma-4-e4b-it-ultra-uncensored-heretic";
    const variantModel = {
      id: `lmstudio/${canonicalKey}@q4_k_m`,
    };
    prepareModel.mockRejectedValueOnce(
      new LmstudioModelLoadError(canonicalKey, undefined, new Error("load failed")),
    );
    const baseStream = doneStream();
    const wrapped = wrap(baseStream);

    const firstEvents = await collectEvents(infer(wrapped, variantModel));
    const secondEvents = await collectEvents(infer(wrapped, variantModel));

    expectDone(firstEvents);
    expectDone(secondEvents);
    expect(prepareModel).toHaveBeenCalledTimes(1);
    expect(baseStream).toHaveBeenCalledTimes(2);
    expectModelCall(baseStream, 0, {
      provider: "lmstudio",
      id: canonicalKey,
    });
    expectModelCall(baseStream, 1, {
      provider: "lmstudio",
      id: canonicalKey,
    });
  });

  it("dedupes concurrent preload requests for the same model and context", async () => {
    await runHeldPreloadScenario(async (held) => {
      expect(prepareModel).toHaveBeenCalledTimes(1);
      expect(held.baseStream).not.toHaveBeenCalled();

      held.release();
      const [firstEvents, secondEvents] = await held.waitFor(
        Promise.all([held.first, held.second]),
      );
      held.assertActive();

      expectDone(firstEvents);
      expectDone(secondEvents);
      expect(prepareModel).toHaveBeenCalledTimes(1);
      expect(held.baseStream).toHaveBeenCalledTimes(2);
    });
  });

  it("does not start model preload for an already-aborted inference", async () => {
    const baseStream = doneStream();
    const wrapped = wrap(baseStream);
    const controller = new AbortController();
    const abortReason = new Error("inference already cancelled");
    controller.abort(abortReason);
    const options = { signal: controller.signal };
    const stream = Promise.resolve().then(() => infer(wrapped, { contextWindow: 32_768 }, options));

    await expect(stream).rejects.toBe(abortReason);
    expect(prepareModel).not.toHaveBeenCalled();
    expect(baseStream).not.toHaveBeenCalled();
  });

  it("cancels one shared preload waiter without cancelling another inference", async () => {
    const controller = new AbortController();
    const abortReason = new DOMException("inference cancelled", "AbortError");

    await runHeldPreloadScenario(async (held) => {
      controller.abort(abortReason);
      const firstOutcome = await held.waitFor(
        held.first.then(
          () => undefined,
          (error: unknown) => error,
        ),
      );
      held.assertActive();

      expect(firstOutcome).toBe(abortReason);
      expect(held.baseStream).not.toHaveBeenCalled();
      expect(prepareModel).toHaveBeenCalledTimes(1);

      held.release();
      const secondEvents = await held.waitFor(held.second);
      held.assertActive();

      expectDone(secondEvents);
      expect(held.baseStream).toHaveBeenCalledTimes(1);
    }, controller.signal);
  });

  it("bounds failed preload retries without blocking inference or dropping tools", async () => {
    prepareModel.mockRejectedValue(new Error("out of memory"));
    const baseStream = doneStream();
    const wrapped = wrap(baseStream);
    const tools = Array.from({ length: 29 }, (_, index) => ({
      name: `agent_tool_${index}`,
      description: `Agent tool ${index}`,
      parameters: { type: "object" },
    }));
    const baseTime = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(baseTime);

    expectDone(
      await collectEvents(
        infer(
          wrapped,
          { contextTokens: 64000.5, contextWindow: Number.POSITIVE_INFINITY },
          undefined,
          { tools },
        ),
      ),
    );
    expect(prepareModel).toHaveBeenCalledTimes(1);
    expectPreload({ requestedContextLength: undefined });

    nowSpy.mockReturnValue(baseTime + 59_999);
    await collectEvents(infer(wrapped, {}));
    expect(prepareModel).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(baseTime + 60_000);
    expectDone(await collectEvents(infer(wrapped, {}, undefined, { tools })));
    expect(prepareModel).toHaveBeenCalledTimes(2);
    for (const callIndex of [0, 2]) {
      expect(vi.mocked(baseStream).mock.calls[callIndex]?.[1].tools).toEqual(tools);
    }

    nowSpy.mockReturnValue(baseTime + 119_999);
    await collectEvents(infer(wrapped, {}));
    expect(prepareModel).toHaveBeenCalledTimes(2);

    nowSpy.mockReturnValue(baseTime + 120_000);
    await collectEvents(infer(wrapped, {}));
    expect(prepareModel).toHaveBeenCalledTimes(3);

    nowSpy.mockReturnValue(baseTime + 179_999);
    await collectEvents(infer(wrapped, {}));
    expect(prepareModel).toHaveBeenCalledTimes(3);
    expect(baseStream).toHaveBeenCalledTimes(6);
  });

  it("preserves and deduplicates configured unsupported tool-schema keywords", async () => {
    const baseStream = doneStream();
    const wrapped = wrap(baseStream);
    const originalCompat = {
      supportsDeveloperRole: false,
      unsupportedToolSchemaKeywords: ["format", "pattern", "minimum", "pattern"],
    };

    expectDone(await collectEvents(infer(wrapped, { compat: originalCompat })));

    expectModel(baseStream, {
      compat: {
        supportsDeveloperRole: false,
        supportsUsageInStreaming: true,
        unsupportedToolSchemaKeywords: ["format", "pattern", "minimum"],
      },
    });
    expect(originalCompat).toEqual({
      supportsDeveloperRole: false,
      unsupportedToolSchemaKeywords: ["format", "pattern", "minimum", "pattern"],
    });
  });

  it("applies regex tool-schema compatibility when LM Studio preload is disabled", async () => {
    const baseStream = doneStream();
    const wrapped = wrap(baseStream, { preload: false });

    expectDone(
      await collectEvents(
        infer(wrapped, {
          id: "qwen3-8b-instruct",
          compat: { unsupportedToolSchemaKeywords: ["format"] },
        }),
      ),
    );

    expect(prepareModel).not.toHaveBeenCalled();
    expect(baseStream).toHaveBeenCalledTimes(1);
    expectModel(baseStream, {
      compat: {
        supportsUsageInStreaming: true,
        unsupportedToolSchemaKeywords: ["format", "pattern"],
      },
    });
  });

  it("promotes standalone bracketed local-model tool text to a structured tool call", async () => {
    const rawToolText = [
      "[mempalace_mempalace_search]",
      '{"query":"codename","wing":"personal","room":"identities"}',
      "[END_TOOL_REQUEST]",
    ].join("\n");
    const baseStream = eventStream([
      { type: "start", partial: assistantMessage([]) },
      {
        type: "text_start",
        contentIndex: 0,
        partial: assistantMessage([{ type: "text", text: "" }]),
      },
      { type: "text_delta", contentIndex: 0, delta: rawToolText },
      { type: "text_end", contentIndex: 0, content: rawToolText },
      {
        type: "done",
        reason: "stop",
        message: assistantMessage([{ type: "text", text: rawToolText }]),
      },
    ]);
    const wrapped = wrap(baseStream);
    const events = await collectEvents(
      infer(wrapped, {}, undefined, {
        tools: [
          {
            name: "mempalace_mempalace_search",
            description: "Search MemPalace",
            parameters: { type: "object", properties: {} },
          },
        ],
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    const done = events.find((event) => event.type === "done") as {
      message?: { content?: Array<Record<string, unknown>>; stopReason?: string };
      reason?: string;
    };
    expect(done).toMatchObject({
      reason: "toolUse",
      message: { stopReason: "toolUse" },
    });
    expect(done.message?.content?.[0]).toEqual(
      expect.objectContaining({
        type: "toolCall",
        name: "mempalace_mempalace_search",
        arguments: { query: "codename", wing: "personal", room: "identities" },
        id: expect.stringMatching(/^call_[a-f0-9]{24}$/),
      }),
    );
  });

  it("rewrites reasoning_effort to the disabled effort when thinking is off", async () => {
    const payload: Record<string, unknown> = {
      model: "qwen3-8b-instruct",
      reasoning_effort: "high",
    };
    const baseStream = payloadStream(payload);
    const wrapped = wrap(baseStream, { thinkingLevel: "off" });
    const events = await collectEvents(infer(wrapped, { compat: BINARY_REASONING_COMPAT }));

    expectDone(events);
    expect(payload.reasoning_effort).toBe("none");
  });
});
