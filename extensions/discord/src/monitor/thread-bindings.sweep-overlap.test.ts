// Discord tests cover thread-binding sweeper in-flight overlap.
//
// Regression guard for `extensions/discord/src/monitor/thread-bindings.manager.ts:513`:
// the production `setInterval` callback fires `runSweepOnce()` unconditionally, so
// when the Discord REST `getChannel` call stalls inside one sweep, the next
// 120_000 ms tick fires another concurrent `runSweepOnce()`. With many active
// bindings, a Discord API stall causes overlapping sweeps that re-probe every
// binding while the previous sweep is still pending, multiplying the load on a
// stalled endpoint.
//
// The fix introduces a per-feature `sweepInFlight` boolean (the same pattern
// used by Alix-007's `notifyPollInFlight` in #106395, `callsBeingReaped` in
// #106396, `refreshInFlight` in #106397, and the slot accounting in #106398).
// The first sweep sets `sweepInFlight = true`; subsequent ticks return early
// until the in-flight sweep settles and the `finally` clears the flag.
//
// This test uses `vi.useFakeTimers()` to drive the real `setInterval` and a
// `createDeferred()`-held `restGet` mock to stall the first sweep. The
// distinguishing metric is the count of `restGet` invocations across N timer
// advances: with the fix it must stay at 1; without the fix it grows to N.
//
// The test does not depend on `process.getActiveResourcesInfo()` because the
// production code calls `.unref()` on the sweep timer at line 519, which hides
// the interval from Node's resource accounting. The invocation count is the
// honest distinguisher (and matches the same `started`-array shape used by
// PR #106398's `client.test.ts` regression test).
//
// The 4th case was attempted in Round 2 of the ClawSweeper review cycle but
// is intentionally absent: undici's internal connection-timeout retry opens
// a second transport under `vi.advanceTimersByTimeAsync(600000)` even though
// the guard correctly suppresses the manager's own `setInterval` callback,
// yielding two TCP arrivals at the held server (one from the initial request,
// one from undici's implicit retry after the connection-timeout fires in
// fake time). The remaining three cases already prove the guard against an
// unbounded deferred REST boundary; the only stand-alone controlled-runtime
// real-network case that survives would also need either to disable undici
// retries or to drive real timers via an SDK seam not available here. See
// `Known limits` in the PR body for the seam map.
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestClient } from "../internal/rest.js";
import { setDiscordRuntime, type DiscordRuntime } from "../runtime.js";
import { EMPTY_DISCORD_TEST_CONFIG } from "../test-support/config.js";

const hoisted = vi.hoisted(() => {
  const sendMessageDiscord = vi.fn(async (_to: string, _text: string, _opts?: unknown) => ({}));
  const sendWebhookMessageDiscord = vi.fn(async (_text: string, _opts?: unknown) => ({}));
  const restGet = vi.fn(async (..._args: unknown[]) => ({
    id: "thread-1",
    type: 11,
    parent_id: "parent-1",
  }));
  const restPost = vi.fn(async (..._args: unknown[]) => ({
    id: "wh-created",
    token: "tok-created",
  }));
  const createDiscordRestClient = vi.fn((..._args: unknown[]) => ({
    rest: { get: restGet, post: restPost },
  }));
  const createThreadDiscord = vi.fn(async (..._args: unknown[]) => ({ id: "thread-created" }));
  const readAcpSessionEntry = vi.fn();
  return {
    sendMessageDiscord,
    sendWebhookMessageDiscord,
    restGet,
    restPost,
    createDiscordRestClient,
    createThreadDiscord,
    readAcpSessionEntry,
  };
});

vi.mock("../send.js", async () => {
  const actual = await vi.importActual<typeof import("../send.js")>("../send.js");
  return {
    ...actual,
    addRoleDiscord: vi.fn(),
    sendMessageDiscord: hoisted.sendMessageDiscord,
    sendWebhookMessageDiscord: hoisted.sendWebhookMessageDiscord,
  };
});

vi.mock("../send.messages.js", () => ({
  createThreadDiscord: hoisted.createThreadDiscord,
}));

const { testing, createThreadBindingManager } = await import("./thread-bindings.manager.js");
import { DISCORD_SWEEP_PROBE_TIMEOUT_MS } from "./thread-bindings.sweep-client.js";
const discordClientModule = await import("../client.js");

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const SWEEP_TICK_MS = 120_000;
const ADVANCE_TICKS = 5;

function createSweepEnabledManager() {
  return createThreadBindingManager({
    accountId: "default",
    cfg: EMPTY_DISCORD_TEST_CONFIG,
    persist: false,
    enableSweeper: true,
    idleTimeoutMs: 24 * 60 * 60 * 1000,
    maxAgeMs: 0,
  });
}

async function bindDefaultThreadTarget(
  manager: ReturnType<typeof createThreadBindingManager>,
): Promise<void> {
  await manager.bindTarget({
    threadId: "thread-1",
    channelId: "parent-1",
    targetKind: "subagent",
    targetSessionKey: "agent:main:subagent:child",
    agentId: "main",
    webhookId: "wh-1",
    webhookToken: "tok-1",
  });
}

describe("thread binding sweep overlap guard", () => {
  let stateDir: string;
  let release: ReturnType<typeof createDeferred<unknown>> | null;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "discord-sweep-overlap-"));
    resetPluginStateStoreForTests();
    testing.resetThreadBindingsForTests();
    setDiscordRuntime({
      state: {
        openSyncKeyedStore: (options: OpenKeyedStoreOptions) =>
          createPluginStateSyncKeyedStoreForTests("discord", options),
      },
    } as unknown as DiscordRuntime);
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
    hoisted.sendMessageDiscord.mockReset().mockResolvedValue({});
    hoisted.sendWebhookMessageDiscord.mockReset().mockResolvedValue({});
    hoisted.restPost.mockReset().mockResolvedValue({
      id: "wh-created",
      token: "tok-created",
    });
    hoisted.createDiscordRestClient.mockReset().mockImplementation((..._args: unknown[]) => ({
      rest: { get: hoisted.restGet, post: hoisted.restPost },
    }));
    hoisted.createThreadDiscord.mockReset().mockResolvedValue({ id: "thread-created" });
    hoisted.readAcpSessionEntry.mockReset().mockReturnValue(null);
    vi.spyOn(discordClientModule, "createDiscordRestClient").mockImplementation(
      (...args) =>
        hoisted.createDiscordRestClient(...args) as unknown as ReturnType<
          typeof discordClientModule.createDiscordRestClient
        >,
    );
    release = createDeferred<unknown>();
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (release) {
      try {
        release.resolve();
        await release.promise;
      } catch {
        // ignore — release may have been rejected by the test body
      }
      release = null;
    }
    if (stateDir) {
      try {
        await rm(stateDir, { recursive: true, force: true });
      } catch {
        // ignore — best-effort cleanup
      }
    }
  });

  it("does not stack overlapping sweeps while the first sweep is still pending", async () => {
    // Wire restGet to a deferred that does not resolve until the test says so.
    let invocations = 0;
    hoisted.restGet.mockReset().mockImplementation(async () => {
      invocations += 1;
      await release.promise;
      return { id: "thread-1", type: 11, parent_id: "parent-1" };
    });

    vi.useFakeTimers();
    const manager = createSweepEnabledManager();
    try {
      await bindDefaultThreadTarget(manager);

      // Advance 5 ticks (5 × 120s = 600s of fake time). With the guard, only
      // the first tick's sweep enters `runSweepOnce`; the rest bail at the
      // `if (sweepInFlight) return;` early-return. Without the guard, all
      // 5 ticks fire concurrent sweeps, each calling restGet.
      await vi.advanceTimersByTimeAsync(SWEEP_TICK_MS * ADVANCE_TICKS);
      // Drain pending microtasks without re-running the interval body so the
      // aborted-loop guard does not trip on the unfixed implementation.
      await vi.advanceTimersByTimeAsync(0);

      expect(invocations).toBe(1);
    } finally {
      manager.stop();
    }
  });

  it("releases the guard after the in-flight sweep resolves successfully", async () => {
    let invocations = 0;
    hoisted.restGet.mockReset().mockImplementation(async () => {
      invocations += 1;
      // First call stalls; release() lets it settle.
      await release.promise;
      return { id: "thread-1", type: 11, parent_id: "parent-1" };
    });

    vi.useFakeTimers();
    const manager = createSweepEnabledManager();
    try {
      await bindDefaultThreadTarget(manager);

      // First tick fires the sweep and stalls on the deferred.
      await vi.advanceTimersByTimeAsync(SWEEP_TICK_MS);
      expect(invocations).toBe(1);

      // Release the in-flight sweep and let the `finally` clear the guard.
      release.resolve();
      // Flush microtasks so the in-flight sweep's promise + finally callback
      // complete before we assert.
      await vi.advanceTimersByTimeAsync(0);

      // Reuse the same release for the second call so it does not stall.
      release = createDeferred<unknown>();
      hoisted.restGet.mockReset().mockImplementation(async () => {
        invocations += 1;
        return { id: "thread-1", type: 11, parent_id: "parent-1" };
      });

      // Advance the next interval; the guard must be cleared so a fresh
      // sweep can fire.
      await vi.advanceTimersByTimeAsync(SWEEP_TICK_MS);
      expect(invocations).toBe(2);
    } finally {
      manager.stop();
    }
  });

  it("releases the guard after the in-flight sweep fails", async () => {
    let invocations = 0;
    hoisted.restGet.mockReset().mockImplementation(async () => {
      invocations += 1;
      await release.promise;
      throw new Error("ECONNRESET");
    });

    vi.useFakeTimers();
    const manager = createSweepEnabledManager();
    try {
      await bindDefaultThreadTarget(manager);

      await vi.advanceTimersByTimeAsync(SWEEP_TICK_MS);
      expect(invocations).toBe(1);

      // Reject the in-flight sweep; the `finally` must still clear the guard.
      release.reject(new Error("ECONNRESET"));
      await vi.advanceTimersByTimeAsync(0);

      // Reuse a fresh deferred for the second call so it does not stall on
      // the previous rejection.
      release = createDeferred<unknown>();
      hoisted.restGet.mockReset().mockImplementation(async () => {
        invocations += 1;
        throw new Error("ECONNRESET-2");
      });

      // Advance the next interval; the guard must be cleared so a fresh
      // sweep can fire (and presumably retry).
      await vi.advanceTimersByTimeAsync(SWEEP_TICK_MS);
      expect(invocations).toBe(2);
    } finally {
      manager.stop();
    }
  });

  it("cancels a never-settling sweep probe and releases the guard", async () => {
    // Mirrors Alix-007's #104290 directory-live hanging-body test: a response
    // body that never closes causes fetch to wait forever, but the sweep-owned
    // REST client's finite timeout aborts the request and the inFlight guard
    // is released so the next sweep can fire.
    function hangingBodyResponse(signal?: AbortSignal): Response {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("["));
          if (signal?.aborted) {
            controller.error(signal.reason);
            return;
          }
          signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => hangingBodyResponse(init?.signal ?? undefined));

    // Replace the thin mock rest with a real RequestClient armed with the same
    // finite timeout the production sweep now passes, so the abort actually
    // reaches the transport layer (not just a mocked rejection).
    hoisted.createDiscordRestClient.mockReset().mockImplementation((...args: unknown[]) => {
      const [{ timeoutMs }] = args as [{ timeoutMs?: number }];
      const client = new RequestClient("test-token", {
        fetch: fetchSpy,
        timeout: timeoutMs ?? DISCORD_SWEEP_PROBE_TIMEOUT_MS,
        queueRequests: false,
      });
      return { rest: client };
    });

    const manager = createSweepEnabledManager();
    try {
      await bindDefaultThreadTarget(manager);

      // First sweep: should fire exactly one probe, then abort at the timeout.
      const firstSweep = testing.runThreadBindingSweepForAccount("default");
      await vi.advanceTimersByTimeAsync(DISCORD_SWEEP_PROBE_TIMEOUT_MS);
      // Must settle (not hang) after the timeout fires.
      await expect(firstSweep).resolves.toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Second sweep: the guard must have been released so a new probe fires.
      fetchSpy.mockClear();
      const secondSweep = testing.runThreadBindingSweepForAccount("default");
      await vi.advanceTimersByTimeAsync(DISCORD_SWEEP_PROBE_TIMEOUT_MS);
      await expect(secondSweep).resolves.toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      manager.stop();
      fetchSpy.mockRestore();
    }
  });
});
