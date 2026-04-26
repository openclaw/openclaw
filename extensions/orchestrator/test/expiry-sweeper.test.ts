import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createExpirySweeper } from "../src/expiry-sweeper.js";
import { createStore } from "../src/store.js";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "orchestrator-sweeper-"));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("createExpirySweeper", () => {
  test("start() does an immediate sweep and arms an interval", () => {
    const store = createStore({ openclawHome: tmpHome });
    store.submit({ goal: "expired-task", submittedBy: "tester", ttlMs: -1 });
    let intervalArmed = false;
    const sweeper = createExpirySweeper({
      store,
      setIntervalFn: () => {
        intervalArmed = true;
        return Symbol("handle");
      },
      clearIntervalFn: () => undefined,
    });
    const result = sweeper.start();
    expect(result.sweptCount).toBeGreaterThanOrEqual(1);
    expect(intervalArmed).toBe(true);
    expect(sweeper.running).toBe(true);
  });

  test("stop() clears the interval and flips running to false", () => {
    const store = createStore({ openclawHome: tmpHome });
    const handle = Symbol("handle");
    let cleared = false;
    const sweeper = createExpirySweeper({
      store,
      setIntervalFn: () => handle,
      clearIntervalFn: (h) => {
        if (h === handle) cleared = true;
      },
    });
    sweeper.start();
    sweeper.stop();
    expect(cleared).toBe(true);
    expect(sweeper.running).toBe(false);
  });

  test("start() is idempotent — second call is a no-op", () => {
    const store = createStore({ openclawHome: tmpHome });
    let armed = 0;
    const sweeper = createExpirySweeper({
      store,
      setIntervalFn: () => {
        armed += 1;
        return Symbol("h");
      },
      clearIntervalFn: () => undefined,
    });
    sweeper.start();
    sweeper.start();
    expect(armed).toBe(1);
  });

  test("interval tick re-runs the sweep", () => {
    const store = createStore({ openclawHome: tmpHome });
    let tick: (() => void) | null = null;
    const sweeper = createExpirySweeper({
      store,
      setIntervalFn: (handler) => {
        tick = handler;
        return Symbol("h");
      },
      clearIntervalFn: () => undefined,
    });
    const swept = vi.spyOn(store, "sweepExpired");
    sweeper.start();
    expect(swept).toHaveBeenCalledTimes(1);
    tick!();
    expect(swept).toHaveBeenCalledTimes(2);
  });

  test("logger.info fires when the sweep finds tasks", () => {
    const store = createStore({ openclawHome: tmpHome });
    store.submit({ goal: "expire-me", submittedBy: "tester", ttlMs: -1 });
    const messages: string[] = [];
    const sweeper = createExpirySweeper({
      store,
      logger: { info: (m) => messages.push(m) },
      setIntervalFn: () => Symbol("h"),
      clearIntervalFn: () => undefined,
    });
    sweeper.start();
    expect(messages.some((m) => m.includes("expired"))).toBe(true);
  });

  test("logger.error fires when sweepExpired throws", () => {
    const store = createStore({ openclawHome: tmpHome });
    vi.spyOn(store, "sweepExpired").mockImplementation(() => {
      throw new Error("fs blew up");
    });
    const messages: string[] = [];
    const sweeper = createExpirySweeper({
      store,
      logger: { error: (m) => messages.push(m) },
      setIntervalFn: () => Symbol("h"),
      clearIntervalFn: () => undefined,
    });
    const result = sweeper.start();
    expect(result.sweptCount).toBe(0);
    expect(messages[0]).toContain("fs blew up");
  });
});
