import { afterEach, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { ensureCodexAppServerClientRuntime } from "./client-runtime.js";
import { createClientHarness } from "./test-support.js";
import {
  mergeCodexRateLimitsUpdate,
  readCodexRateLimitsRevision,
  readRecentCodexRateLimits,
  rememberCodexRateLimitsRead,
} from "./rate-limit-cache.js";

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
const account = {
  credits: { balance: "5" },
  individualLimit: { remainingPercent: 68 },
  planType: "pro",
};
const snapshot = (limitId: string | null, usedPercent: number) => ({
  ...unavailable,
  limitId,
  primary: { usedPercent },
});

afterEach(() => vi.restoreAllMocks());
it("shares snapshots across module copies while isolating clients and expiring old reads", async () => {
  const now = vi.spyOn(performance, "now").mockReturnValue(100);
  const first = clientIdentity();
  const second = clientIdentity();
  expect(readCodexRateLimitsRevision(first)).toBe(0);
  rememberCodexRateLimitsRead(first, { rateLimits: { limitId: "codex" } });
  now.mockReturnValue(200);
  rememberCodexRateLimitsRead(second, { rateLimits: { limitId: "codex_other" } });
  vi.resetModules();
  const copy = await import("./rate-limit-cache.js");
  for (const read of [readCodexRateLimitsRevision, copy.readCodexRateLimitsRevision]) {
    expect([first, second].map(read)).toEqual([1, 0]);
  }

  now.mockReturnValue(600_099);
  expect([first, second].map((client) => readRecentCodexRateLimits(client))).toEqual([
    { rateLimits: { limitId: "codex" } },
    { rateLimits: { limitId: "codex_other" } },
  ]);
  now.mockReturnValue(600_100);
  expect(copy.readRecentCodexRateLimits(first)).toBeUndefined();
  expect(copy.readRecentCodexRateLimits(second)).toEqual({
    rateLimits: { limitId: "codex_other" },
  });
});

it("expires the cached read on elapsed time even when the wall clock steps back", async () => {
  const wall = vi.spyOn(Date, "now").mockReturnValue(1_000_000_000_000);
  const elapsed = vi.spyOn(performance, "now").mockReturnValue(0);
  const client = clientIdentity();
  rememberCodexRateLimitsRead(client, { rateLimits: { limitId: "codex" } });
  // Real elapsed time passes the 10-minute max-age window…
  elapsed.mockReturnValue(10 * 60_000);
  // …while the wall clock steps backward, so a Date.now-keyed window would never lapse.
  wall.mockReturnValue(1_000_000_000_000 - 60 * 60_000);
  expect(readRecentCodexRateLimits(client)).toBeUndefined();
});

it("serves a fresh snapshot over the real client runtime until elapsed time passes despite a wall-clock step back", async () => {
  // Real client transport + real notification wiring + real rate-limit cache module.
  const harness = createClientHarness();
  ensureCodexAppServerClientRuntime(harness.client, { agentDir: "/tmp/agent" });
  const wall = vi.spyOn(Date, "now").mockReturnValue(1_000_000_000_000);
  const elapsed = vi.spyOn(performance, "now").mockReturnValue(0);
  try {
    // The real codex app-server notification path records the snapshot.
    harness.send({
      method: "account/rateLimits/updated",
      params: { rateLimits: { limitId: "codex" } },
    });
    await vi.waitFor(() =>
      expect(readRecentCodexRateLimits(harness.client)).toEqual({
        rateLimits: { limitId: "codex" },
      }),
    );
    // Real elapsed time passes the 10-minute max-age window…
    elapsed.mockReturnValue(10 * 60_000 + 1);
    // …while the wall clock steps backward, so a Date.now-keyed window would never lapse.
    wall.mockReturnValue(1_000_000_000_000 - 60 * 60_000);
    expect(readRecentCodexRateLimits(harness.client)).toBeUndefined();
  } finally {
    harness.client.close();
    harness.emitExit();
    await harness.client.closeAndWait().catch(() => undefined);
  }
});

it("merges sparse rolling updates without clearing account metadata", () => {
  const client = clientIdentity();
  const codexSnapshot = {
    ...snapshot("codex", 10),
    ...account,
    limitName: "Codex",
    primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1000 },
    secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 2000 },
    rateLimitReachedType: "rate_limit_reached",
  };
  const otherSnapshot = {
    ...snapshot("codex_other", 30),
    limitName: "Other",
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
      rateLimits: snapshot(limitId, usedPercent),
    });
  }
  expect(readCodexRateLimitsRevision(client)).toBe(2);

  const mergedCodexSnapshot = { ...snapshot("codex", 90), ...account };
  expect(readRecentCodexRateLimits(client)).toEqual({
    rateLimits: mergedCodexSnapshot,
    rateLimitsByLimitId: {
      codex: mergedCodexSnapshot,
      codex_other: { ...snapshot("codex_other", 75), ...account },
    },
  });
});
