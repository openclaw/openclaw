import type { Model } from "openclaw/plugin-sdk/llm";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { guardedFetch } = vi.hoisted(() => ({
  guardedFetch: vi.fn<typeof fetchWithSsrFGuard>(),
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: guardedFetch,
}));

import { createOllamaStreamFn } from "./stream.runtime.js";

const model: Model = {
  api: "ollama",
  provider: "ollama",
  baseUrl: "http://localhost:11434",
  id: "qwen3:4b",
  name: "Qwen3 4B",
  reasoning: true,
  input: ["text"],
  contextWindow: 32768,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const notify = vi.fn();
const start = (options: { signal?: AbortSignal } = {}, id = model.id) =>
  createOllamaStreamFn(model.baseUrl)(
    { ...model, id },
    { messages: [] },
    { onProviderWait: notify, ...options },
  );
const pendingFetch = () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof fetchWithSsrFGuard>>>();
  guardedFetch.mockReturnValue(pending.promise);
  return pending;
};
beforeEach(() => {
  vi.useFakeTimers();
  notify.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  guardedFetch.mockReset();
});

describe("native Ollama held request status", () => {
  it("uses honest fallback wording after HTTP acceptance and clears on the first record", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    guardedFetch.mockResolvedValue({
      finalUrl: "http://localhost:11434/api/chat",
      response: new Response(body),
      release: async () => {},
    });
    const stream = await start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(notify.mock.calls).toEqual([["response"]]);
    const enqueue = (content: string, done: boolean) =>
      controller?.enqueue(
        new TextEncoder().encode(
          `${JSON.stringify({ message: { role: "assistant", content }, done })}\n`,
        ),
      );
    enqueue("ok", false);
    await vi.advanceTimersByTimeAsync(0);
    expect(notify.mock.calls).toEqual([["response"], [null]]);
    enqueue("", true);
    controller?.close();
    expect((await stream.result()).stopReason).toBe("stop");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["cancel", "failure"] as const)("clears a held request on %s", async (ending) => {
    const controller = new AbortController();
    const pending = pendingFetch();
    const stream = await start({ signal: controller.signal });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(notify.mock.calls).toEqual([["response"]]);
    if (ending === "cancel") {
      controller.abort();
      expect(notify.mock.calls).toEqual([["response"], [null]]);
    }
    pending.reject(new Error("request stopped"));
    expect((await stream.result()).stopReason).toBe(ending === "cancel" ? "aborted" : "error");
    expect(notify.mock.calls).toEqual([["response"], [null]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not label a held cloud request as a local-model wait", async () => {
    const pending = pendingFetch();
    const stream = await start({}, "qwen3:cloud");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(notify).not.toHaveBeenCalled();
    pending.reject(new Error("request stopped"));
    await stream.result();
    expect(vi.getTimerCount()).toBe(0);
  });
});
