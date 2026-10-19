import type { Model } from "@openclaw/llm-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { createOpenAIResponsesAssistantOutput } from "./openai-responses-replay-internal.js";
import {
  assignTransportErrorDetails,
  createModelStreamCooperativeScheduler,
  notifyProviderHttpMetadata,
  notifyProviderHttpResponse,
  parseTerminalToolCallArguments as parseArguments,
  withProviderAcceptanceObserver,
} from "./transport-stream-shared.js";

const REPAIR = { repairStringLiterals: true } as const;
const initialHost = getAiTransportHost();
const model = { provider: "openai", id: "fixture-model", api: "openai-responses" } as Model;
afterEach(() => configureAiTransportHost(initialHost));

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
    for (const secret of ["PRIVATE OUTPUT", "PRIVATE PROMPT", "PRIVATE CAUSE"]) {
      expect(JSON.stringify(logWarn.mock.calls)).not.toContain(secret);
    }
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
    new ReadableStream<Uint8Array>({
      cancel() {
        markCancelStarted();
        return new Promise<void>(() => {});
      },
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
describe("model stream cooperative scheduler", { concurrent: false }, () => {
  let now = 0;

  beforeEach(() => {
    now = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(async () => {
    try {
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("starts a fresh event and elapsed-time budget after a delayed yield", async () => {
    const scheduler = createModelStreamCooperativeScheduler();

    async function checkEvent(deliveredAt?: number) {
      let settled = false;
      const event = scheduler.afterEvent().then(() => {
        settled = true;
      });
      // Check before awaiting so an unexpected yield fails without a timer timeout.
      expect(vi.getTimerCount()).toBe(deliveredAt === undefined ? 0 : 1);
      if (deliveredAt !== undefined) {
        await Promise.resolve();
        expect(settled).toBe(false);
        now = deliveredAt;
        await vi.runOnlyPendingTimersAsync();
      }
      await event;
      expect(settled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    }

    for (const deliveredAt of [25, 50]) {
      for (let index = 0; index < 63; index += 1) {
        await checkEvent();
      }
      await checkEvent(deliveredAt);
    }

    now = 61;
    await checkEvent();
    now = 62;
    await checkEvent(87);
    await checkEvent();
  });

  it.each(["before event", "during yield"] as const)(
    "preserves a coded abort reason %s",
    async (phase) => {
      const controller = new AbortController();
      const reason = Object.assign(new Error("Stream canceled"), { code: "TEST_CANCELED" });
      const scheduler = createModelStreamCooperativeScheduler(controller.signal);
      if (phase === "before event") {
        controller.abort(reason);
      } else {
        now = 12;
      }
      const event = scheduler.afterEvent();
      const rejected = expect(event).rejects.toBe(reason);
      if (phase === "during yield") {
        expect(vi.getTimerCount()).toBe(1);
        controller.abort(reason);
        now = 37;
        await vi.runOnlyPendingTimersAsync();
      }
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
