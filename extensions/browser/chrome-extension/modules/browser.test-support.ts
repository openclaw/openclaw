import { vi } from "vitest";

export function chromeEvent<Args extends unknown[]>() {
  let listener: (...args: Args) => void = () => {
    throw new Error("Chrome event listener was not registered");
  };
  return {
    addListener: (next: (...args: Args) => void) => {
      listener = next;
    },
    emit: (...args: Args) => listener(...args),
  };
}

export function storageArea(
  seed: Record<string, unknown> = {},
  before: (operation: "get" | "set" | "remove", keys: string[]) => void = () => {},
) {
  const values = { ...seed };
  return {
    values,
    get: vi.fn(async (keys: string[]) => {
      before("get", keys);
      return Object.fromEntries(
        keys.filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]]),
      );
    }),
    set: vi.fn(async (next: Record<string, unknown>) => {
      before("set", Object.keys(next));
      Object.assign(values, next);
    }),
    remove: vi.fn(async (keys: string[]) => {
      before("remove", keys);
      for (const key of keys) {
        delete values[key];
      }
    }),
  };
}
