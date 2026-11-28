import { afterEach, expect, it, vi } from "vitest";
import { createCliContextPublisher } from "./context-usage.js";

afterEach(() => {
  vi.useRealTimers();
});

it("coalesces to the latest observation, even when it returns to the last written count", async () => {
  vi.useFakeTimers();
  const first = Promise.withResolvers<void>();
  const write = vi.fn(async (_tokens: number) => {}).mockImplementationOnce(() => first.promise);
  await using publisher = createCliContextPublisher(write);
  publisher.observe(200);
  expect(write.mock.calls).toEqual([[200]]);
  for (const n of [201, 202, 200]) {
    publisher.observe(n);
  }
  first.resolve();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(write.mock.calls).toEqual([[200]]);
  publisher.observe(180);
  for (const n of [181, 182, 175]) {
    publisher.observe(n);
  }
  await vi.advanceTimersByTimeAsync(1_000);
  expect(write.mock.calls).toEqual([[200], [180], [175]]);
});

it("drains an active write before settlement without starting a pending write", async () => {
  vi.useFakeTimers();
  const { promise, resolve } = Promise.withResolvers<void>();
  const write = vi.fn((_tokens: number) => promise);
  const publisher = createCliContextPublisher(write);
  publisher.observe(200);
  publisher.observe(300);
  await vi.advanceTimersByTimeAsync(5_000);
  let settled = false;
  const close = publisher[Symbol.asyncDispose]().then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  resolve();
  await close;
  publisher.observe(500);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(write.mock.calls).toEqual([[200]]);
});
