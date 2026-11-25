import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createMcpRequestLifecycle } from "./mcp-request-lifecycle.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("MCP request deadlines", () => {
  it.each(["forward", "backward"] as const)(
    "keeps the human-input budget when the wall clock jumps %s",
    async (direction) => {
      vi.useFakeTimers();
      const lifecycle = createMcpRequestLifecycle(60_000);
      const entered = createDeferred<AbortSignal>();
      const finished = createDeferred<string>();
      const pending = lifecycle.run({ requestTimeoutMs: 30_000 }, async (signal, hold) => {
        if (direction === "forward") {
          vi.setSystemTime(Date.now() + 120_000);
        } else {
          const release = hold();
          vi.setSystemTime(Date.now() - 120_000);
          release();
        }
        hold();
        entered.resolve(signal);
        return finished.promise;
      });
      try {
        const signal = await entered.promise;
        await vi.advanceTimersByTimeAsync(89_999);
        expect(signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(signal.aborted).toBe(true);
        expect(lifecycle.didTimeout(signal.reason)).toBe(true);
      } finally {
        finished.resolve("result");
        await pending;
      }
    },
  );
});
