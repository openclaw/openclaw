import type { Model, StreamOptions } from "@openclaw/llm-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import {
  copyProviderAcceptanceObserver,
  createModelStreamCooperativeScheduler,
  finalizeTerminalToolCallArguments,
  notifyProviderHttpMetadata,
  notifyProviderHttpResponse,
  notifyProviderStreamOpened,
  parseTerminalToolCallArguments,
  withProviderAcceptanceObserver,
  type ProviderAcceptance,
} from "./transport-stream-shared.js";

const MALFORMED_TOOL_CALL_TERMINAL_ERROR_MESSAGE =
  "Provider completed tool call with malformed JSON arguments";
const REPAIR = { repairStringLiterals: true } as const;

function captureError(run: () => unknown): Error & { errorCode?: string; errorBody?: string } {
  try {
    run();
  } catch (error) {
    return error as Error & { errorCode?: string; errorBody?: string };
  }
  throw new Error("expected a throw");
}

describe("parseTerminalToolCallArguments", () => {
  it("preserves unsafe integer literals and surrounding argument values", () => {
    expect(
      parseTerminalToolCallArguments(
        '{"target":9223372036854775807,"safe":42,"negative":-9223372036854775808,"fraction":9007199254740992.0,"exponent":1e20,"text":"literal 9223372036854775807 \\"quoted\\" 日本語😀","last":9007199254740992}',
      ),
    ).toEqual({
      target: "9223372036854775807",
      safe: 42,
      negative: "-9223372036854775808",
      fraction: 9007199254740992,
      exponent: 1e20,
      text: 'literal 9223372036854775807 "quoted" 日本語😀',
      last: "9007199254740992",
    });
    expect(parseTerminalToolCallArguments({})).toEqual({});
  });

  it("stays strict by default: raw control characters are rejected without repair", () => {
    const thrown = captureError(() =>
      parseTerminalToolCallArguments('{"path":"a.py","newText":"x = 1\ny = 2"}'),
    );
    expect(thrown.message).toBe(MALFORMED_TOOL_CALL_TERMINAL_ERROR_MESSAGE);
    expect(thrown.cause).toMatchObject({ repairAttempted: false });
  });

  it("repairs invalid escapes by preserving the backslash the model meant", () => {
    // JS string is: {"command":"grep -E \d+ file"} — an unescaped regex backslash.
    expect(
      parseTerminalToolCallArguments('{"command":"grep -E \\d+ file"}', undefined, REPAIR),
    ).toEqual({ command: "grep -E \\d+ file" });
  });

  it("preserves valid control escapes in sibling fields, even after a path-like prefix", () => {
    // oldText legitimately contains a newline (a valid \n escape after "C:"); newText has a raw
    // newline that needs repair. The repair must not turn oldText into a literal backslash-n.
    const raw =
      '{"id":9223372036854775807,"path":"C:\\\\app\\\\a.py","oldText":"C:\\nnext","newText":"x = 1\ny = 2"}';
    expect(parseTerminalToolCallArguments(raw, undefined, REPAIR)).toEqual({
      id: "9223372036854775807",
      path: "C:\\app\\a.py",
      oldText: "C:\nnext",
      newText: "x = 1\ny = 2",
    });
  });

  it.each([
    null,
    // Never turn a truncated command into a shorter executable command.
    '{"command":"rm -rf /srv/app/tmp/bu',
  ])("rejects non-object or malformed terminal input %# without exposing it", (value) => {
    for (const options of [undefined, REPAIR]) {
      const thrown = captureError(() => parseTerminalToolCallArguments(value, undefined, options));
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

describe("finalizeTerminalToolCallArguments", () => {
  it("does not mutate any sibling when one call stays malformed", () => {
    const calls = [
      {
        name: "read",
        arguments: {} as Record<string, unknown>,
        partialJson: '{"path":"README.md"}',
      },
      {
        name: "read",
        arguments: {} as Record<string, unknown>,
        partialJson: '{"path":"SECRET.md"',
      },
    ];
    expect(() =>
      finalizeTerminalToolCallArguments(calls, (call) => call.partialJson, undefined, REPAIR),
    ).toThrow(MALFORMED_TOOL_CALL_TERMINAL_ERROR_MESSAGE);
    expect(calls[0]?.arguments).toEqual({});
    expect(calls[1]?.arguments).toEqual({});
  });
});

const model = { id: "acceptance-test", provider: "test" } as Model;

function observeAcceptance(
  observer: (acceptance: ProviderAcceptance) => void,
  options: StreamOptions = {},
): StreamOptions {
  return withProviderAcceptanceObserver(options, observer);
}

describe("private provider acceptance", () => {
  it("reports a successful HTTP response before the compatibility callback", async () => {
    const calls: string[] = [];
    const observer = vi.fn((acceptance: ProviderAcceptance) => {
      calls.push(acceptance.kind);
    });
    const onResponse = vi.fn(() => {
      calls.push("onResponse");
    });
    const options = observeAcceptance(observer, { onResponse });
    const response = new Response(null, {
      status: 200,
      headers: { "x-request-id": "request-1" },
    });

    await notifyProviderHttpResponse({ options, response, model });

    expect(observer).toHaveBeenCalledWith({
      kind: "http_response",
      status: 200,
      headers: { "x-request-id": "request-1" },
    });
    expect(onResponse).toHaveBeenCalledWith(
      { status: 200, headers: { "x-request-id": "request-1" } },
      model,
    );
    expect(calls).toEqual(["http_response", "onResponse"]);
  });

  it("does not wait for unread response cancellation after the observer fails", async () => {
    const hookError = new Error("acceptance failed");
    let markCancelStarted!: () => void;
    const cancelStarted = new Promise<void>((resolve) => {
      markCancelStarted = resolve;
    });
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          markCancelStarted();
          return new Promise<void>(() => {});
        },
      }),
      { status: 200 },
    );
    const options = observeAcceptance(() => {
      throw hookError;
    });
    const notification = notifyProviderHttpResponse({ options, response, model });

    await cancelStarted;
    await expect(notification).rejects.toBe(hookError);
  });

  it("preserves the observer when built-in wrappers rebuild options", async () => {
    const observer = vi.fn();
    const source = observeAcceptance(observer);
    const target = copyProviderAcceptanceObserver(source, {});

    const cancelStream = vi.fn();
    await notifyProviderStreamOpened({ options: target, cancelStream });

    expect(observer).toHaveBeenCalledWith({ kind: "provider_stream_opened" });
    expect(cancelStream).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)(
    "observes actual callback and cancellation work when a callback later %ss",
    async (outcome) => {
      const host = getAiTransportHost();
      const observed: Promise<unknown>[] = [];
      const events: string[] = [];
      const controller = new AbortController();
      let callbackStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        callbackStarted = resolve;
      });
      const lateCallbackError = new Error("late response failure");
      const cleanupError = new Error("cancellation failure");
      let finishCallback!: () => void;
      const callback = new Promise<void>((resolve, reject) => {
        finishCallback = () => (outcome === "resolve" ? resolve() : reject(lateCallbackError));
      });
      let finishCleanup!: () => void;
      const cleanup = new Promise<void>((_resolve, reject) => {
        finishCleanup = () => reject(cleanupError);
      });
      configureAiTransportHost({
        ...host,
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
        configureAiTransportHost(host);
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
