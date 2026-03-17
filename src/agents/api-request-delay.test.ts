import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelApiRequestDelayConfig } from "./api-request-delay.js";
import {
  MODEL_API_REQUEST_DELAY_MS_MAX,
  clearApiRequestDelayLimitersForTest,
  resolveModelApiRequestDelayMs,
  wrapStreamFnWithApiRequestDelay,
} from "./api-request-delay.js";

describe("api-request-delay", () => {
  beforeEach(() => {
    clearApiRequestDelayLimitersForTest();
  });
  afterEach(() => {
    clearApiRequestDelayLimitersForTest();
  });

  describe("resolveModelApiRequestDelayMs", () => {
    it("returns 0 when unset", () => {
      expect(resolveModelApiRequestDelayMs(undefined, "openai")).toBe(0);
      expect(resolveModelApiRequestDelayMs({} as ModelApiRequestDelayConfig, "openai")).toBe(0);
    });

    it("uses models.requestDelayMs", () => {
      expect(
        resolveModelApiRequestDelayMs(
          { models: { requestDelayMs: 250 } } as ModelApiRequestDelayConfig,
          "x",
        ),
      ).toBe(250);
    });

    it("prefers per-provider requestDelayMs", () => {
      const cfg = {
        models: {
          requestDelayMs: 100,
          providers: {
            glm: {
              requestDelayMs: 50,
              baseUrl: "https://example",
              models: [],
            },
          },
        },
      } as ModelApiRequestDelayConfig;
      expect(resolveModelApiRequestDelayMs(cfg, "glm")).toBe(50);
      expect(resolveModelApiRequestDelayMs(cfg, "other")).toBe(100);
    });

    it("caps at MODEL_API_REQUEST_DELAY_MS_MAX", () => {
      expect(
        resolveModelApiRequestDelayMs(
          { models: { requestDelayMs: 9_000_000 } } as ModelApiRequestDelayConfig,
          "p",
        ),
      ).toBe(MODEL_API_REQUEST_DELAY_MS_MAX);
    });

    it("ignores non-finite values", () => {
      expect(
        resolveModelApiRequestDelayMs(
          { models: { requestDelayMs: Number.NaN } } as ModelApiRequestDelayConfig,
          "p",
        ),
      ).toBe(0);
    });
  });

  describe("wrapStreamFnWithApiRequestDelay", () => {
    it("returns inner unchanged when delay is 0", () => {
      const inner = vi.fn(() => Promise.resolve("x"));
      const wrapped = wrapStreamFnWithApiRequestDelay(inner as never, "p", 0);
      expect(wrapped).toBe(inner);
    });

    it("spaces consecutive invocations by delayMs", async () => {
      vi.useFakeTimers();
      try {
        const inner = vi.fn(() => Promise.resolve("ok"));
        const wrapped = wrapStreamFnWithApiRequestDelay(inner as never, "prov", 100);

        const p1 = wrapped(null as never, null as never, null);
        await Promise.resolve();
        await p1;
        expect(inner).toHaveBeenCalledTimes(1);

        const p2 = wrapped(null as never, null as never, null);
        await Promise.resolve();
        expect(inner).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(100);
        await p2;
        expect(inner).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("uses separate limiters per provider", async () => {
      vi.useFakeTimers();
      try {
        const innerA = vi.fn(() => Promise.resolve("a"));
        const innerB = vi.fn(() => Promise.resolve("b"));
        const wA = wrapStreamFnWithApiRequestDelay(innerA as never, "a", 500);
        const wB = wrapStreamFnWithApiRequestDelay(innerB as never, "b", 500);

        void wA(null as never, null as never, null);
        void wB(null as never, null as never, null);
        await Promise.resolve();
        expect(innerA).toHaveBeenCalledTimes(1);
        expect(innerB).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
