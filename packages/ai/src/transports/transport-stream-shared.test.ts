import type { Model } from "@openclaw/llm-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { makeStallingStream } from "../providers/provider-stream.test-support.js";
import { createOpenAIResponsesAssistantOutput } from "./openai-responses-replay-internal.js";
import {
  assignTransportErrorDetails,
  iterateModelStream,
  notifyProviderHttpMetadata,
  notifyProviderHttpResponse,
  parseTerminalToolCallArguments as parseArguments,
  withProviderAcceptanceObserver,
  withProviderResponseHook,
} from "./transport-stream-shared.js";

const REPAIR = { repairStringLiterals: true } as const;
const initialHost = getAiTransportHost();
const model = { provider: "openai", id: "fixture-model", api: "openai-responses" } as Model;
afterEach(() => {
  configureAiTransportHost(initialHost);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(["error", "data"] as const)(
  "logs failure metadata without response.%s prose or generated content",
  (bodyField) => {
    const logWarn = vi.fn();
    const body = {
      code: "invalid_prompt",
      type: "invalid_request_error",
      message: `PRIVATE PROMPT ${"x".repeat(6000)}`,
    };
    const output = createOpenAIResponsesAssistantOutput(model);
    configureAiTransportHost({ ...initialHost, logWarn });
    assignTransportErrorDetails(
      output,
      Object.assign(new Error(body.message), {
        status: 400,
        code: body.code,
        request_id: "req_fixture",
        errorType: body.type,
        cause: Object.assign(new Error("PRIVATE CAUSE"), { code: "ECONNRESET" }),
        response: {
          id: "resp_fixture",
          [bodyField]: body,
          output: [{ text: "PRIVATE OUTPUT" }],
        },
      }),
    );
    expect(logWarn).toHaveBeenCalledWith("provider-error", "Model request failed", {
      provider: "openai",
      model: "fixture-model",
      status: 400,
      code: "invalid_prompt",
      type: "invalid_request_error",
      causeName: "Error",
      causeCode: "ECONNRESET",
      requestId: "req_fixture",
      responseId: "resp_fixture",
    });
    expect(output.errorType).toBe("invalid_request_error");
    expect(output.errorBody?.length).toBeLessThan(6000);
    expect(JSON.stringify(logWarn.mock.calls)).not.toMatch(/PRIVATE (?:OUTPUT|PROMPT|CAUSE)/u);
  },
);

function captureError(run: () => unknown): Error & { errorCode?: string; errorBody?: string } {
  try {
    run();
  } catch (error) {
    return error as Error & { errorCode?: string; errorBody?: string };
  }
  throw new Error("expected a throw");
}

it("repairs invalid escapes by preserving the backslash the model meant", () => {
  // JS string is: {"command":"grep -E \d+ file"} — an unescaped regex backslash.
  expect(parseArguments('{"command":"grep -E \\d+ file"}', undefined, REPAIR)).toEqual({
    command: "grep -E \\d+ file",
  });
});

it.each([
  null,
  // Never turn a truncated command into a shorter executable command.
  '{"command":"rm -rf /srv/app/tmp/bu',
])("rejects non-object or malformed terminal input %# without exposing it", (value) => {
  for (const options of [undefined, REPAIR]) {
    const thrown = captureError(() => parseArguments(value, undefined, options));
    const diagnostics = {
      code: "malformed_tool_call_arguments",
      argumentChars: value?.length ?? 0,
      argumentHash: value === null ? "" : expect.stringMatching(/^[0-9a-z]+$/),
      repairAttempted: options === REPAIR && typeof value === "string",
    };
    expect(thrown).toMatchObject({
      message: "Provider completed tool call with malformed JSON arguments",
      errorCode: "malformed_tool_call_arguments",
    });
    expect(thrown.cause).toEqual(diagnostics);
    expect(JSON.parse(thrown.errorBody ?? "{}")).toEqual(diagnostics);
    const surfaced = `${String(thrown)}${JSON.stringify(thrown.cause ?? null)}${thrown.errorBody ?? ""}`;
    expect(surfaced).not.toContain("rm -rf");
  }
});
it("does not wait for unread response cancellation after the observer fails", async () => {
  const hookError = new Error("acceptance failed");
  const { promise: cancelStarted, resolve: markCancelStarted } = Promise.withResolvers<void>();
  const response = new Response(
    makeStallingStream([], () => {
      markCancelStarted();
      return new Promise<void>(() => {});
    }),
  );
  const options = withProviderAcceptanceObserver({}, () => {
    throw hookError;
  });
  const notification = notifyProviderHttpResponse({ options, response, model });

  await cancelStarted;
  await expect(notification).rejects.toBe(hookError);
});

it.each(["resolve", "reject"] as const)(
  "observes actual callback and cancellation work when a callback later %ss",
  async (outcome) => {
    const observed: Promise<unknown>[] = [];
    const events: string[] = [];
    const controller = new AbortController();
    const { promise: started, resolve: callbackStarted } = Promise.withResolvers<void>();
    const lateCallbackError = new Error("late response failure");
    const cleanupError = new Error("cancellation failure");
    const callback = Promise.withResolvers<void>();
    const finishCallback = () =>
      outcome === "resolve" ? callback.resolve() : callback.reject(lateCallbackError);
    const cleanup = Promise.withResolvers<void>();
    configureAiTransportHost({
      ...initialHost,
      observePendingProviderWork: (pending) => {
        events.push("observed");
        observed.push(pending);
      },
    });
    const cancelStream = vi.fn(() => {
      events.push("cancel");
      return cleanup.promise;
    });
    const onResponse = vi.fn(() => {
      events.push("callback");
      callbackStarted();
      return callback.promise;
    });
    const notification = notifyProviderHttpMetadata({
      options: { signal: controller.signal, onResponse },
      response: { status: 200, headers: {} },
      model,
      cancelStream,
    });
    try {
      expect(onResponse).not.toHaveBeenCalled();
      await started;
      controller.abort();
      await expect(notification).rejects.toThrow("Request was aborted");
      expect(events).toEqual(["observed", "callback", "cancel", "observed"]);
      expect(cancelStream).toHaveBeenCalledOnce();
      expect(observed[1]).toBe(cleanup.promise);
      finishCallback();
      if (outcome === "resolve") {
        await expect(observed[0]).resolves.toBeUndefined();
      } else {
        await expect(observed[0]).rejects.toBe(lateCallbackError);
      }
      cleanup.reject(cleanupError);
      await expect(observed[1]).rejects.toBe(cleanupError);
    } finally {
      controller.abort();
      finishCallback();
      cleanup.reject(cleanupError);
      await Promise.allSettled([notification, callback.promise, cleanup.promise, ...observed]);
    }
  },
);

it("preserves the lifecycle failure when cancellation throws synchronously", async () => {
  const callbackError = new Error("response failure");
  const cancelStream = vi.fn(() => {
    throw new Error("cancel failure");
  });
  await expect(
    notifyProviderHttpMetadata({
      options: {
        onResponse: () => {
          throw callbackError;
        },
      },
      response: { status: 200, headers: {} },
      model,
      cancelStream,
    }),
  ).rejects.toBe(callbackError);
  expect(cancelStream).toHaveBeenCalledOnce();
});
it.each([
  { count: 2, mode: "ready" },
  { count: 80, mode: "ready" },
  { count: 80, mode: "held" },
  { count: 80, mode: "body" },
])(
  "preserves stream order and only yields large batches ($count streams, $mode)",
  async ({ count, mode }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(Date, "now").mockReturnValue(0);
    const events = Array.from({ length: count }, () => [] as string[]);
    let starts = 0;
    let startsBeforeTimer = -1;
    let completed = 0;
    let completedBeforeTimer = -1;
    const hooks = Promise.withResolvers<void>();
    const values = mode === "body" ? ["body"] : ["1", "2", "3", "4", "5"];
    const streams = events.map(async (received) => {
      const controller = new AbortController();
      const source =
        mode === "body"
          ? values
          : withProviderResponseHook({
              stream: (async function* () {
                yield* values;
              })(),
              signal: controller.signal,
              abort: (error) => controller.abort(error),
              hook: mode === "held" ? () => hooks.promise : undefined,
              onReady() {
                starts++;
                received.push("start");
              },
            });
      for await (const event of iterateModelStream(source, controller.signal)) {
        received.push(event);
        if (mode === "body") {
          starts++;
        }
      }
      completed++;
    });
    if (mode === "held") {
      await vi.runAllTimersAsync();
    }
    setTimeout(() => {
      startsBeforeTimer = starts;
      completedBeforeTimer = completed;
    }, 0);
    hooks.resolve();
    await vi.runAllTimersAsync();
    await Promise.all(streams);
    if (count === 2) {
      expect(completedBeforeTimer).toBe(2);
    } else {
      expect(startsBeforeTimer).toBeGreaterThan(0);
      expect(startsBeforeTimer).toBeLessThan(count);
    }
    expect(completed).toBe(count);
    expect(events).toEqual(
      Array.from({ length: count }, () => (mode === "body" ? values : ["start", ...values])),
    );
  },
);

describe("model stream cooperative scheduler", { concurrent: false }, () => {
  let now = 0;

  beforeEach(() => {
    now = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(async () => {
    await vi.runAllTimersAsync();
  });

  it("adds no per-event async checkpoints while the shared turn has capacity", async () => {
    const values = Array.from({ length: 16 }, (_, index) => index);
    async function countCheckpoints(stream: AsyncIterable<number>) {
      let finished = false;
      let checkpoints = 0;
      const probe = (async () => {
        // A stalled iterator must still let the runner's deadline fire.
        while (checkpoints < 1024) {
          if (finished) {
            break;
          }
          await Promise.resolve();
          checkpoints++;
        }
      })();
      const received: number[] = [];
      try {
        for await (const value of stream) {
          received.push(value);
        }
      } finally {
        finished = true;
        await probe;
      }
      return { checkpoints, received };
    }
    const control = await countCheckpoints(
      (async function* (source: AsyncIterable<number> | Iterable<number>) {
        for await (const value of source) {
          yield value;
        }
      })(values),
    );
    const scheduled = await countCheckpoints(iterateModelStream(values));
    expect(control.checkpoints).toBeGreaterThan(values.length);
    expect(control.received).toEqual(values);
    expect(scheduled.received).toEqual(values);
    // The control includes iterator/consumer work; ready budget admission needs no extra await.
    expect(scheduled.checkpoints).toBeLessThanOrEqual(control.checkpoints);
  });

  it("stops before pulling upstream again after cancellation", async () => {
    const controller = new AbortController();
    const reason = Object.assign(new Error("Stream canceled"), { code: "TEST_CANCELED" });
    let pulls = 0;
    let closed = false;
    const upstream = (async function* () {
      try {
        pulls++;
        yield "first";
        pulls++;
        throw new Error("Upstream advanced after cancellation");
      } finally {
        closed = true;
      }
    })();
    const stream = iterateModelStream(upstream, controller.signal);
    await expect(stream.next()).resolves.toEqual({ done: false, value: "first" });
    controller.abort(reason);
    await expect(stream.next()).rejects.toBe(reason);
    expect(pulls).toBe(1);
    expect(closed).toBe(true);
  });

  it("starts a fresh elapsed-time budget after a delayed yield", async () => {
    const stream = iterateModelStream(["first", "second", "third"]);
    await expect(stream.next()).resolves.toEqual({ done: false, value: "first" });
    now = 6;
    const second = stream.next();
    let delivered = false;
    void second.then(() => {
      delivered = true;
    });
    await Promise.resolve();
    expect(delivered).toBe(false);
    now = 25;
    await vi.runOnlyPendingTimersAsync();
    await expect(second).resolves.toEqual({ done: false, value: "second" });
    // Waiting for the loop must not consume the newly available work budget.
    await expect(stream.next()).resolves.toEqual({ done: false, value: "third" });
    await stream.return(undefined);
  });

  it.each(["before event", "during yield"] as const)(
    "preserves a coded abort reason %s",
    async (phase) => {
      const controller = new AbortController();
      const reason = Object.assign(new Error("Stream canceled"), { code: "TEST_CANCELED" });
      const stream = iterateModelStream(["first", "second"], controller.signal);
      if (phase === "before event") {
        controller.abort(reason);
      } else {
        await stream.next();
        now = 6;
      }
      const event = stream.next();
      const rejected = expect(event).rejects.toBe(reason);
      if (phase === "during yield") {
        await Promise.resolve();
        controller.abort(reason);
        now = 37;
        await vi.runOnlyPendingTimersAsync();
      }
      await rejected;
    },
  );
});
