import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createRuntimeAuthProfileRowsCache } from "./runtime-persisted-rows.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("shares immutable persisted rows across cache hits", async () => {
  const databasePath = path.join(tempDirs.make("auth-row-cache-"), "auth.sqlite");
  const rows = {
    store: {
      status: "readable" as const,
      raw: {
        version: 1,
        profiles: {
          "example:key": {
            type: "api_key",
            provider: "example",
            keyRef: { source: "env", provider: "default", id: "EXAMPLE_KEY" },
          },
        },
      },
    },
    state: { status: "readable" as const, raw: { order: { example: ["example:key"] } } },
    cacheable: true,
  };
  const read = vi.fn(async () => rows);
  const cache = createRuntimeAuthProfileRowsCache(() => ({ rows: "1", selection: "1" }));
  const resolve = () => cache.prepare(databasePath, { read, assertCurrent: () => {} }).read();
  const first = await resolve();
  expect(await resolve()).toBe(first);
  expect(read).toHaveBeenCalledTimes(1);
  // Reject changes at every retained level, including credential refs and order arrays.
  function assertImmutable(value: unknown) {
    if (value === null || typeof value !== "object") {
      return;
    }
    expect(Reflect.set(value, "injected", true)).toBe(false);
    for (const [key, child] of Object.entries(value)) {
      expect(Reflect.set(value, key, null)).toBe(false);
      assertImmutable(child);
    }
  }
  assertImmutable(first);
  expect(await resolve()).toEqual(rows);
});
