import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { expect, it } from "vitest";
import { createSignalMonitorTaskRunner, SIGNAL_IDLE_DRAIN_TIMEOUT_MS } from "./monitor.js";

function createRuntime(errors: string[]): RuntimeEnv {
  return {
    log: () => {},
    error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
    exit: () => {},
  };
}

it("returns after the drain window when a receive never finishes", async () => {
  const errors: string[] = [];
  const runner = createSignalMonitorTaskRunner(createRuntime(errors), 20);
  let release = () => {};
  const heldReply = new Promise<void>((resolve) => {
    release = resolve;
  });
  void runner.runTask(() => heldReply);

  const startedAt = Date.now();
  await runner.waitForIdle();

  expect(Date.now() - startedAt).toBeLessThan(1_000);
  expect(errors.join(" ")).toContain("made no progress within 20ms");
  expect(errors.join(" ")).toContain("1 task(s) still in flight");
  release();
});

it("returns without logging when the in-flight work drains", async () => {
  const errors: string[] = [];
  const runner = createSignalMonitorTaskRunner(createRuntime(errors), 30_000);
  await runner.runTask(async () => {});

  await runner.waitForIdle();

  expect(errors).toEqual([]);
});

it("waits for work that settles inside the window", async () => {
  const errors: string[] = [];
  const runner = createSignalMonitorTaskRunner(createRuntime(errors), 30_000);
  const task = runner.runTask(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      }),
  );

  await runner.waitForIdle();

  expect(errors).toEqual([]);
  await task;
});

it("keeps the shipped drain window at 30 seconds", () => {
  expect(SIGNAL_IDLE_DRAIN_TIMEOUT_MS).toBe(30_000);
});
