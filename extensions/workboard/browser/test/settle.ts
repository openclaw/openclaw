import { flush } from "solid-js";
import { vi } from "vitest";

export async function afterWorkboardUpdate<T>(read: () => T): Promise<T> {
  // Settle mocked requests and zero-delay work, then render once; never retry assertions.
  await vi.advanceTimersByTimeAsync(0);
  flush();
  return read();
}
