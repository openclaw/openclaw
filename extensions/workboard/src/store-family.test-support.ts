import { expect, vi } from "vitest";
import type { WorkboardStore } from "./store.js";

export const expectRejected = (work: Promise<unknown>, error?: string | RegExp) =>
  expect(work).rejects.toThrow(error);

export const expectStored = async (store: WorkboardStore, id: string, shape: object) =>
  expect(await store.get(id)).toMatchObject(shape);

export const contains = (...shapes: Record<string, unknown>[]) =>
  expect.arrayContaining(shapes.map((shape) => expect.objectContaining(shape)));

export function fakeClock() {
  vi.useFakeTimers();
  return {
    set: (now: number) => vi.setSystemTime(now),
    [Symbol.dispose]: () => vi.useRealTimers(),
  };
}
