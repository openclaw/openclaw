import type { Model, StreamOptions } from "@openclaw/llm-core";
import { describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import {
  copyProviderAcceptanceObserver,
  notifyProviderHttpMetadata,
  notifyProviderHttpResponse,
  notifyProviderStreamOpened,
  withProviderAcceptanceObserver,
  type ProviderAcceptance,
} from "./transport-stream-shared.js";

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

  it("reports a rejected HTTP response without marking it accepted", async () => {
    const observer = vi.fn();
    const onResponse = vi.fn();
    const options = observeAcceptance(observer, { onResponse });
    const response = new Response("rejected", { status: 429 });

    await notifyProviderHttpResponse({ options, response, model });

    expect(observer).not.toHaveBeenCalled();
    expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({ status: 429 }), model);
  });

  it.each(["observer", "onResponse"] as const)(
    "cancels an unread response when the %s fails",
    async (failureSource) => {
      const hookError = new Error(`${failureSource} failed`);
      const cancel = vi.fn();
      const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 200 });
      const options =
        failureSource === "observer"
          ? observeAcceptance(() => {
              throw hookError;
            })
          : ({ onResponse: () => Promise.reject(hookError) } satisfies StreamOptions);

      await expect(notifyProviderHttpResponse({ options, response, model })).rejects.toBe(
        hookError,
      );

      expect(cancel).toHaveBeenCalledWith(hookError);
    },
  );

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

  it("reports an opaque stream without canceling it", async () => {
    const observer = vi.fn();
    const cancelStream = vi.fn();
    const options = observeAcceptance(observer);

    await notifyProviderStreamOpened({ options, cancelStream });

    expect(observer).toHaveBeenCalledWith({ kind: "provider_stream_opened" });
    expect(cancelStream).not.toHaveBeenCalled();
  });

  it("preserves the observer when built-in wrappers rebuild options", async () => {
    const observer = vi.fn();
    const source = observeAcceptance(observer);
    const target = copyProviderAcceptanceObserver(source, {});

    await notifyProviderStreamOpened({ options: target, cancelStream: vi.fn() });

    expect(observer).toHaveBeenCalledWith({ kind: "provider_stream_opened" });
  });

  it("cancels a metadata-only SDK stream when its compatibility callback fails", async () => {
    const hookError = new Error("response callback failed");
    const cancelStream = vi.fn();

    await expect(
      notifyProviderHttpMetadata({
        options: { onResponse: () => Promise.reject(hookError) },
        response: { status: 200, headers: {} },
        model,
        cancelStream,
      }),
    ).rejects.toBe(hookError);

    expect(cancelStream).toHaveBeenCalledWith(hookError);
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
