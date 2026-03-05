import { describe, expect, it, vi } from "vitest";
import type { AcpRuntime } from "../runtime/types.js";
import type { AcpRuntimeHandle } from "../runtime/types.js";
import type { CachedRuntimeState } from "./runtime-cache.js";
import { RuntimeCache } from "./runtime-cache.js";

function mockState(sessionKey: string): CachedRuntimeState {
  const runtime = {
    ensureSession: vi.fn(async () => ({
      sessionKey,
      backend: "acpx",
      runtimeSessionName: `runtime:${sessionKey}`,
    })),
    runTurn: vi.fn(async function* () {
      yield { type: "done" as const };
    }),
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  } as unknown as AcpRuntime;
  return {
    runtime,
    handle: {
      sessionKey,
      backend: "acpx",
      runtimeSessionName: `runtime:${sessionKey}`,
    } as AcpRuntimeHandle,
    backend: "acpx",
    agent: "codex",
    mode: "persistent",
  };
}

describe("RuntimeCache", () => {
  it("tracks idle candidates with touch-aware lookups", () => {
    vi.useFakeTimers();
    try {
      const cache = new RuntimeCache();
      const actor = "agent:codex:acp:s1";
      cache.set(actor, mockState(actor), { now: 1_000 });

      expect(cache.collectIdleCandidates({ maxIdleMs: 1_000, now: 1_999 })).toHaveLength(0);
      expect(cache.collectIdleCandidates({ maxIdleMs: 1_000, now: 2_000 })).toHaveLength(1);

      cache.get(actor, { now: 2_500 });
      expect(cache.collectIdleCandidates({ maxIdleMs: 1_000, now: 3_200 })).toHaveLength(0);
      expect(cache.collectIdleCandidates({ maxIdleMs: 1_000, now: 3_500 })).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts least-recently-touched entries when size exceeds maxEntries", () => {
    const cache = new RuntimeCache({ maxEntries: 2 });
    cache.set("a", mockState("a"), { now: 10 });
    cache.set("b", mockState("b"), { now: 20 });

    // Touch "a" so "b" becomes the eviction candidate.
    cache.get("a", { now: 30 });
    cache.set("c", mockState("c"), { now: 40 });

    expect(cache.size()).toBe(2);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("c")).toBe(true);
    expect(cache.has("b")).toBe(false);
  });

  it("returns snapshot entries with idle durations", () => {
    const cache = new RuntimeCache();
    cache.set("a", mockState("a"), { now: 10 });
    cache.set("b", mockState("b"), { now: 100 });

    const snapshot = cache.snapshot({ now: 1_100 });
    const byActor = new Map(snapshot.map((entry) => [entry.actorKey, entry]));
    expect(byActor.get("a")?.idleMs).toBe(1_090);
    expect(byActor.get("b")?.idleMs).toBe(1_000);
  });
});
