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

const MALFORMED_TOOL_CALL_TERMINAL_ERROR_MESSAGE =
  "Provider completed tool call with malformed JSON arguments";
const REPAIR = { repairStringLiterals: true } as const;
const initialHost = getAiTransportHost();
afterEach(() => configureAiTransportHost(initialHost));

describe("transport failure diagnostics", () => {
  it.each(["error", "data"] as const)(
    "logs failure metadata without response.%s prose or generated content",
    (bodyField) => {
      const logWarn = vi.fn();
      const body = {
        code: "invalid_prompt",
        type: "invalid_request_error",
        message: `PRIVATE PROMPT ${"x".repeat(6000)}`,
      };
      const output = createOpenAIResponsesAssistantOutput({
        provider: "openai",
        id: "fixture-model",
        api: "openai-responses",
      } as Model);
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
});

function captureError(run: () => unknown): Error & { errorCode?: string; errorBody?: string } {
  try {
    run();
  } catch (error) {
    return error as Error & { errorCode?: string; errorBody?: string };
  }
  throw new Error("expected a throw");
}

describe("parseTerminalToolCallArguments", () => {
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
      expect(thrown).toMatchObject({ message: MALFORMED_TOOL_CALL_TERMINAL_ERROR_MESSAGE });
      const diagnostics = {
        code: "malformed_tool_call_arguments",
        argumentChars: value?.length ?? 0,
        argumentHash: value === null ? "" : expect.stringMatching(/^[0-9a-z]+$/),
        repairAttempted: options === REPAIR && typeof value === "string",
      };
      expect(thrown.cause).toEqual(diagnostics);
      expect(thrown.errorCode).toBe("malformed_tool_call_arguments");
      expect(JSON.parse(thrown.errorBody ?? "{}")).toEqual(diagnostics);
      const surfaced = `${String(thrown)}${JSON.stringify(thrown.cause ?? null)}${thrown.errorBody ?? ""}`;
      expect(surfaced).not.toContain("rm -rf");
    }
  });
});

const model = { id: "acceptance-test", provider: "test" } as Model;

describe("private provider acceptance", () => {
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
      { status: 200 },
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
      const callbackWork = Promise.withResolvers<void>();
      const callback = callbackWork.promise;
      const finishCallback = () =>
        outcome === "resolve" ? callbackWork.resolve() : callbackWork.reject(lateCallbackError);
      const { promise: cleanup, reject: rejectCleanup } = Promise.withResolvers<void>();
      const finishCleanup = () => rejectCleanup(cleanupError);
      configureAiTransportHost({
        ...initialHost,
        observePendingProviderWork: (pending) => {
          events.push("observed");
          observed.push(pending);
        },
      });
      const cancelStream = vi.fn(() => {
        events.push("cancel");
        return cleanup;
      });
      const onResponse = vi.fn(() => {
        events.push("callback");
        callbackStarted();
        return callback;
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
        expect(observed[1]).toBe(cleanup);
        finishCallback();
        if (outcome === "resolve") {
          await expect(observed[0]).resolves.toBeUndefined();
        } else {
          await expect(observed[0]).rejects.toBe(lateCallbackError);
        }
        finishCleanup();
        await expect(observed[1]).rejects.toBe(cleanupError);
      } finally {
        controller.abort();
        finishCallback();
        finishCleanup();
        await Promise.allSettled([notification, callback, cleanup, ...observed]);
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

    async function expectImmediateEvent() {
      const event = scheduler.afterEvent();
      // Check before awaiting so an unexpected yield fails without a timer timeout.
      expect(vi.getTimerCount()).toBe(0);
      await event;
    }

    async function finishYieldAt(deliveredAt: number) {
      let settled = false;
      const event = scheduler.afterEvent().then(() => {
        settled = true;
      });
      expect(vi.getTimerCount()).toBe(1);
      await Promise.resolve();
      expect(settled).toBe(false);
      now = deliveredAt;
      await vi.runOnlyPendingTimersAsync();
      await event;
      expect(settled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    }

    for (let index = 0; index < 63; index += 1) {
      await expectImmediateEvent();
    }
    await finishYieldAt(25);

    for (let index = 0; index < 63; index += 1) {
      await expectImmediateEvent();
    }
    await finishYieldAt(50);

    now = 61;
    await expectImmediateEvent();
    now = 62;
    await finishYieldAt(87);
    await expectImmediateEvent();
  });

  it.each(["before event", "during yield"] as const)(
    "preserves a coded abort reason %s",
    async (phase) => {
      const controller = new AbortController();
      const reason = Object.assign(new Error("Stream canceled"), { code: "TEST_CANCELED" });
      const scheduler = createModelStreamCooperativeScheduler(controller.signal);
      if (phase === "before event") {
        controller.abort(reason);
        await expect(scheduler.afterEvent()).rejects.toBe(reason);
        expect(vi.getTimerCount()).toBe(0);
        return;
      }

      now = 12;
      const event = scheduler.afterEvent();
      const rejected = expect(event).rejects.toBe(reason);
      expect(vi.getTimerCount()).toBe(1);
      controller.abort(reason);
      now = 37;
      await vi.runOnlyPendingTimersAsync();
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
