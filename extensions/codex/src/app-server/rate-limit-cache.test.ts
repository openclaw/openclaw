import { describe, expect, it, vi } from "vitest";
import { ensureCodexAppServerClientRuntime } from "./client-runtime.js";
import type { CodexAppServerClient } from "./client.js";
import {
  mergeCodexRateLimitsUpdate,
  readCodexRateLimitsRevision,
  readRecentCodexRateLimits,
  rememberCodexRateLimitsRead,
} from "./rate-limit-cache.js";
import { createClientHarness } from "./test-support.js";

function clientIdentity(): CodexAppServerClient {
  return {} as unknown as CodexAppServerClient;
}

const unavailable = {
  limitId: null,
  limitName: null,
  secondary: null,
  credits: null,
  individualLimit: null,
  planType: null,
  rateLimitReachedType: null,
};

describe("Codex rate-limit cache", () => {
  it("isolates snapshots by physical client", () => {
    const first = clientIdentity();
    const second = clientIdentity();
    expect(readCodexRateLimitsRevision(first)).toBe(0);
    rememberCodexRateLimitsRead(first, { rateLimits: { limitId: "codex" } }, 100);
    rememberCodexRateLimitsRead(second, { rateLimits: { limitId: "codex_other" } }, 200);
    expect(readCodexRateLimitsRevision(first)).toBe(1);
    expect(readCodexRateLimitsRevision(second)).toBe(0);

    expect(
      [first, second].map((client) => readRecentCodexRateLimits(client, { nowMs: 250 })),
    ).toEqual([{ rateLimits: { limitId: "codex" } }, { rateLimits: { limitId: "codex_other" } }]);
    expect(readRecentCodexRateLimits(first, { nowMs: 301, maxAgeMs: 200 })).toBeUndefined();
    expect(readRecentCodexRateLimits(second, { nowMs: 301, maxAgeMs: 200 })).toEqual({
      rateLimits: { limitId: "codex_other" },
    });
  });

  it("merges sparse rolling updates without clearing account metadata", () => {
    const client = clientIdentity();
    const codexSnapshot = {
      limitId: "codex",
      limitName: "Codex",
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1000 },
      secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 2000 },
      credits: { balance: "5" },
      individualLimit: { remainingPercent: 68 },
      planType: "pro",
      rateLimitReachedType: "rate_limit_reached",
    };
    const otherSnapshot = {
      ...unavailable,
      limitId: "codex_other",
      limitName: "Other",
      primary: { usedPercent: 30, windowDurationMins: 60, resetsAt: 4000 },
      planType: "pro",
    };
    rememberCodexRateLimitsRead(client, {
      rateLimits: codexSnapshot,
      rateLimitsByLimitId: { codex: codexSnapshot, codex_other: otherSnapshot },
    });

    for (const [limitId, usedPercent] of [
      [null, 90],
      ["codex_other", 75],
    ] as const) {
      mergeCodexRateLimitsUpdate(client, {
        rateLimits: { ...unavailable, limitId, primary: { usedPercent } },
      });
    }
    expect(readCodexRateLimitsRevision(client)).toBe(2);

    const mergedCodexSnapshot = {
      ...unavailable,
      limitId: "codex",
      primary: { usedPercent: 90 },
      credits: codexSnapshot.credits,
      individualLimit: codexSnapshot.individualLimit,
      planType: "pro",
    };
    const mergedOtherSnapshot = {
      ...mergedCodexSnapshot,
      limitId: "codex_other",
      primary: { usedPercent: 75 },
    };
    expect(readRecentCodexRateLimits(client)).toEqual({
      rateLimits: mergedCodexSnapshot,
      rateLimitsByLimitId: {
        codex: mergedCodexSnapshot,
        codex_other: mergedOtherSnapshot,
      },
    });
  });

  it("shares physical-client notification snapshots across same-build module copies", async () => {
    const harness = createClientHarness();
    let stopObserving: (() => void) | undefined;
    try {
      const addNotificationHandler = vi.spyOn(harness.client, "addNotificationHandler");
      ensureCodexAppServerClientRuntime(harness.client, { agentDir: "/tmp/agent" });

      vi.resetModules();
      const nextRuntime = await import("./client-runtime.js");
      const nextCache = await import("./rate-limit-cache.js");
      nextRuntime.ensureCodexAppServerClientRuntime(harness.client, { agentDir: "/tmp/agent" });
      expect(addNotificationHandler).toHaveBeenCalledTimes(1);

      const notificationObserved = new Promise<void>((resolve) => {
        stopObserving = harness.client.addNotificationHandler((notification) => {
          if (notification.method === "account/rateLimits/updated") {
            resolve();
          }
        });
      });
      harness.send({
        method: "account/rateLimits/updated",
        params: { rateLimits: { limitId: "codex", primary: { usedPercent: 90 } } },
      });
      await notificationObserved;
      expect(readCodexRateLimitsRevision(harness.client)).toBe(1);
      expect(nextCache.readCodexRateLimitsRevision(harness.client)).toBe(1);
      expect(nextCache.readRecentCodexRateLimits(harness.client)).toMatchObject({
        rateLimits: { limitId: "codex", primary: { usedPercent: 90 } },
      });
    } finally {
      stopObserving?.();
      harness.client.close();
    }
  });
});
