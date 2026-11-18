import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createAssistantMessageEventStream, type AssistantMessage } from "openclaw/plugin-sdk/llm";
import { NON_ENV_SECRETREF_MARKER } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  awaitGateBeforeSettlement,
  createZeroUsageFixture,
  withinTest,
} from "openclaw/plugin-sdk/test-fixtures";
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

function expectModelCall(baseStream: StreamFn, callIndex: number, fields: Record<string, unknown>) {
  expect(vi.mocked(baseStream).mock.calls[callIndex]?.[0]).toMatchObject(fields);
}

async function collectEvents(stream: ReturnType<StreamFn>): Promise<StreamEvent[]> {
  const resolved = await stream;
  const events: StreamEvent[] = [];
  for await (const event of resolved) {
    events.push(event as StreamEvent);
  }
  return events;
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

async function runHeldPreloadScenario(
  signal: AbortSignal,
  run: (held: HeldPreloadScenario) => Promise<void>,
  firstSignal?: AbortSignal,
): Promise<void> {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  prepareModel.mockImplementationOnce(() => {
    entered.resolve();
    return release.promise;
  });
  const { baseStream, run: inferHeld } = harness();
  const first = Promise.resolve().then(() =>
    inferHeld({ contextWindow: 32_768 }, firstSignal ? { signal: firstSignal } : undefined),
  );
  // A signal-free peer drains shared preload even if the first caller is cancelled.
  const second = Promise.resolve().then(() => inferHeld({ contextWindow: 32_768 }));
  const settled = Promise.allSettled([first, second]);
  const cleanup = async () => {
    release.resolve();
    await settled;
  };
  finishHeldPreloadScenario = cleanup;
  const waitFor = <T>(promise: Promise<T>) => withinTest(promise, signal);
  try {
    await waitFor(
      awaitGateBeforeSettlement(
        entered.promise,
        Promise.race([first, second]),
        "LM Studio inference completed before preload entry",
      ),
    );
    signal.throwIfAborted();
    await run({
      baseStream,
      first,
      second,
      release: release.resolve,
      waitFor,
      assertActive: () => signal.throwIfAborted(),
    });
  } finally {
    await cleanup();
  }
}

function harness(params?: Parameters<typeof wrap>[1]) {
  const baseStream = eventStream([{ type: "done", reason: "stop", message: assistantMessage([]) }]);
  const wrapped = wrap(baseStream, params);
  return {
    baseStream,
    run: (model = {}, options?: Record<string, unknown>, context?: Record<string, unknown>) =>
      collectEvents(infer(wrapped, model, options, context)),
  };
}

describe("lmstudio stream wrapper", () => {
  beforeEach(() => {
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

  it.each(["success", "cooldown"])("retains canonical model identity after %s", async (outcome) => {
    const canonicalKey = "gemma-4-e4b-it-ultra-uncensored-heretic";
    if (outcome === "success") {
      prepareModel.mockResolvedValueOnce({ modelKey: canonicalKey });
    } else {
      prepareModel.mockRejectedValueOnce(
        new LmstudioModelLoadError(canonicalKey, undefined, new Error("load failed")),
      );
    }
    const { run, baseStream } = harness();
    const model = { id: `lmstudio/${canonicalKey}@q4_k_m` };
    expectDone(await run(model));
    expectPreload({ modelKey: `${canonicalKey}@q4_k_m`, baseUrl: `${defaultBaseUrl}/v1` });
    expectModelCall(baseStream, 0, {
      provider: "lmstudio",
      id: canonicalKey,
      compat: { supportsUsageInStreaming: true, unsupportedToolSchemaKeywords: ["pattern"] },
    });
    if (outcome === "cooldown") {
      expectDone(await run(model));
      expectModelCall(baseStream, 1, { provider: "lmstudio", id: canonicalKey });
      expect(prepareModel).toHaveBeenCalledTimes(1);
    }
  });

  it("resolves native preload credentials when runtime auth is a non-secret marker", async () => {
    resolveApiKey.mockResolvedValueOnce("synthetic-configured-key");
    const { run } = harness();
    expectDone(await run({}, { apiKey: NON_ENV_SECRETREF_MARKER }));
    expectPreload({ apiKey: "synthetic-configured-key" });
  });

  it("dedupes concurrent preload requests for the same model and context", async ({ signal }) => {
    await runHeldPreloadScenario(signal, async (held) => {
      expect(prepareModel).toHaveBeenCalledTimes(1);
      expect(held.baseStream).not.toHaveBeenCalled();
      held.release();
      const events = await held.waitFor(Promise.all([held.first, held.second]));
      held.assertActive();
      events.forEach(expectDone);
      expect(prepareModel).toHaveBeenCalledTimes(1);
      expect(held.baseStream).toHaveBeenCalledTimes(2);
    });
  });

  it("does not start model preload for an already-aborted inference", async () => {
    const { run, baseStream } = harness();
    const reason = new Error("inference already cancelled");
    await expect(
      Promise.resolve().then(() => run({}, { signal: AbortSignal.abort(reason) })),
    ).rejects.toBe(reason);
    expect(prepareModel).not.toHaveBeenCalled();
    expect(baseStream).not.toHaveBeenCalled();
  });

  it("cancels one shared preload waiter without cancelling another inference", async ({
    signal,
  }) => {
    const controller = new AbortController();
    const reason = new DOMException("inference cancelled", "AbortError");
    await runHeldPreloadScenario(
      signal,
      async (held) => {
        controller.abort(reason);
        await held.waitFor(expect(held.first).rejects.toBe(reason));
        held.assertActive();
        expect(held.baseStream).not.toHaveBeenCalled();
        expect(prepareModel).toHaveBeenCalledTimes(1);
        held.release();
        expectDone(await held.waitFor(held.second));
        held.assertActive();
        expect(held.baseStream).toHaveBeenCalledTimes(1);
      },
      controller.signal,
    );
  });

  it("bounds failed preload retries without blocking inference or dropping tools", async () => {
    prepareModel.mockRejectedValue(new Error("out of memory"));
    const { run, baseStream } = harness();
    const tools = Array.from({ length: 29 }, (_, index) => ({
      name: `agent_tool_${index}`,
      description: `Agent tool ${index}`,
      parameters: { type: "object" },
    }));
    const now = vi.spyOn(Date, "now");
    for (const [offset, loads] of [
      [0, 1],
      [59_999, 1],
      [60_000, 2],
      [119_999, 2],
      [120_000, 3],
      [179_999, 3],
    ] as const) {
      now.mockReturnValue(1_000_000 + offset);
      expectDone(
        await run({ contextTokens: 64000.5, contextWindow: Number.POSITIVE_INFINITY }, undefined, {
          tools,
        }),
      );
      expect(prepareModel).toHaveBeenCalledTimes(loads);
    }
    expectPreload({ requestedContextLength: undefined });
    expect(baseStream).toHaveBeenCalledTimes(6);
    for (const call of vi.mocked(baseStream).mock.calls) {
      expect(call[1].tools).toEqual(tools);
    }
  });

  it.each([true, false])("keeps tool-schema compatibility with preload=%s", async (preload) => {
    const { run, baseStream } = harness(preload ? undefined : { preload: false });
    const compat = {
      supportsDeveloperRole: false,
      unsupportedToolSchemaKeywords: ["format", "pattern", "minimum", "pattern"],
    };
    expectDone(await run({ compat }));
    if (!preload) {
      expect(prepareModel).not.toHaveBeenCalled();
    }
    expectModelCall(baseStream, 0, {
      compat: {
        supportsDeveloperRole: false,
        supportsUsageInStreaming: true,
        unsupportedToolSchemaKeywords: ["format", "pattern", "minimum"],
      },
    });
    expect(compat.unsupportedToolSchemaKeywords).toEqual([
      "format",
      "pattern",
      "minimum",
      "pattern",
    ]);
  });
});
