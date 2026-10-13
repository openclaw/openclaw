import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { withOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openXGuestUsage, XGuestUsageUnavailableError } from "./guest-usage.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

function runtime(
  state: OpenClawTestState,
  capacity?: number,
): Parameters<typeof openXGuestUsage>[0] {
  return {
    state: {
      resolveStateDir: () => state.stateDir,
      openKeyedStore: <T>(options: OpenAsyncKeyedStoreOptions) => {
        const bounded =
          capacity === undefined || options.retention === "retained"
            ? options
            : { ...options, maxEntries: capacity };
        return createPluginStateKeyedStoreForTests<T>("x", { ...bounded, env: state.env });
      },
    },
  };
}

const request = {
  accountId: "default",
  authorId: "123",
  limit: 2,
  assertCurrent() {},
};

beforeEach(() => resetPluginStateStoreForTests({ closeDatabase: false }));
afterEach(() => {
  vi.useRealTimers();
  resetPluginStateStoreForTests({ closeDatabase: false });
});

describe("X guest daily usage", () => {
  it("keeps concurrent admissions within quota, deduplicates retries, and resets at UTC midnight", async () => {
    await withOpenClawTestState({ label: "x-guest-daily-usage" }, async (state) => {
      const midnight = Math.floor(Date.now() / DAY_MS) * DAY_MS + DAY_MS;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(midnight - 1);
      const host = runtime(state);
      const usage = openXGuestUsage(host);
      const settled = await Promise.allSettled(
        Array.from({ length: 6 }, (_, index) => usage.admit({ ...request, postId: String(index) })),
      );
      const results = settled.map((result) => {
        if (result.status === "rejected") {
          throw result.reason;
        }
        return result.value;
      });
      expect(results.filter(Boolean)).toHaveLength(2);
      expect(await usage.counts("default")).toEqual({ admittedToday: 2, rateLimitedToday: 4 });

      const admittedPostId = String(results.findIndex(Boolean));
      const rejectedPostId = String(results.findIndex((admitted) => !admitted));
      const reopened = openXGuestUsage(host);
      expect(await reopened.admit({ ...request, postId: admittedPostId, limit: 1 })).toBe(true);
      expect(await reopened.admit({ ...request, postId: rejectedPostId })).toBe(false);
      expect(await usage.counts("default")).toEqual({ admittedToday: 2, rateLimitedToday: 4 });

      expect(await usage.admit({ ...request, postId: admittedPostId, limit: 0 })).toBe(false);
      expect(await usage.admit({ ...request, postId: "other-author", authorId: "456" })).toBe(true);
      expect(
        await usage.admit({ ...request, postId: "other-account", accountId: "secondary" }),
      ).toBe(true);
      expect(await usage.counts("default")).toEqual({ admittedToday: 3, rateLimitedToday: 5 });
      expect(await usage.counts("secondary")).toEqual({ admittedToday: 1, rateLimitedToday: 0 });

      vi.setSystemTime(midnight);
      expect(await usage.counts("default")).toEqual({ admittedToday: 0, rateLimitedToday: 0 });
      expect(await usage.admit({ ...request, postId: admittedPostId })).toBe(true);
      expect(await usage.counts("default")).toEqual({ admittedToday: 0, rateLimitedToday: 0 });
      expect(await usage.admit({ ...request, postId: "next-day-1" })).toBe(true);
      expect(await usage.admit({ ...request, postId: "next-day-2" })).toBe(true);
      expect(await usage.admit({ ...request, postId: "next-day-3" })).toBe(false);
      expect(await usage.counts("default")).toEqual({ admittedToday: 2, rateLimitedToday: 1 });
    });
  });

  it("fails closed at storage capacity without evicting an existing author's quota", async () => {
    await withOpenClawTestState({ label: "x-guest-usage-capacity" }, async (state) => {
      const usage = openXGuestUsage(runtime(state, 1));
      expect(await usage.admit({ ...request, postId: "first", limit: 1 })).toBe(true);
      await expect(
        usage.admit({ ...request, postId: "other", authorId: "456" }),
      ).rejects.toBeInstanceOf(XGuestUsageUnavailableError);
      expect(await usage.admit({ ...request, postId: "over-limit", limit: 1 })).toBe(false);
      expect(await usage.admit({ ...request, postId: "first", limit: 1 })).toBe(true);
      expect(await usage.counts("default")).toEqual({ admittedToday: 1, rateLimitedToday: 1 });
    });
  });

  it.each([
    ["request retirement", "request retired"],
    ["UTC rollover", "usage day changed"],
  ])("does not spend stale quota after %s during a state read", async (change, message) => {
    await withOpenClawTestState({ label: "x-guest-usage-authority" }, async (state) => {
      const midnight = Math.floor(Date.now() / DAY_MS) * DAY_MS + DAY_MS;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(midnight - 1);
      const host = runtime(state);
      const open = host.state.openKeyedStore;
      const observed = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      host.state.openKeyedStore = <T>(options: OpenAsyncKeyedStoreOptions) => {
        const store = open<T>(options);
        return {
          ...store,
          withCurrent(authority) {
            const bound = store.withCurrent?.(authority);
            if (!bound) {
              throw new Error("Missing real action-bound state capability");
            }
            return {
              ...bound,
              async observe(key) {
                const row = await bound.observe(key);
                observed.resolve();
                await resume.promise;
                return row;
              },
            };
          },
        };
      };
      const usage = openXGuestUsage(host);
      let current = true;
      const pending = usage.admit({
        ...request,
        postId: "retired",
        assertCurrent() {
          if (!current) {
            throw new Error("request retired");
          }
        },
      });
      try {
        await awaitGateBeforeSettlement(
          observed.promise,
          pending,
          "Guest admission settled before its state read",
        );
        if (change === "UTC rollover") {
          vi.setSystemTime(midnight);
        } else {
          current = false;
        }
      } finally {
        resume.resolve();
      }
      await expect(pending).rejects.toThrow(message);
      vi.setSystemTime(midnight - 1);
      expect(await usage.counts("default")).toEqual({ admittedToday: 0, rateLimitedToday: 0 });
    });
  });
});
