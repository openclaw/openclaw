import { expect, it, vi } from "vitest";

const SESSION_WRITE_LOCK_TEST_API = Symbol.for("openclaw.sessionWriteLockTestApi");
const testEnvKeys = [
  "VITEST",
  "VITEST_MODE",
  "VITEST_POOL_ID",
  "VITEST_WORKER_ID",
  "NODE_ENV",
] as const;

it("registers the test API for a Vitest worker without VITEST", async () => {
  const previousEnv = Object.fromEntries(testEnvKeys.map((key) => [key, process.env[key]]));
  const previousTestApi = (globalThis as Record<PropertyKey, unknown>)[SESSION_WRITE_LOCK_TEST_API];

  try {
    for (const key of testEnvKeys) {
      delete process.env[key];
    }
    process.env.VITEST_POOL_ID = "worker-only-regression";
    delete (globalThis as Record<PropertyKey, unknown>)[SESSION_WRITE_LOCK_TEST_API];
    vi.resetModules();

    await import("./session-write-lock.js");

    expect((globalThis as Record<PropertyKey, unknown>)[SESSION_WRITE_LOCK_TEST_API]).toMatchObject(
      {
        resetSessionWriteLockStateForTest: expect.any(Function),
        testing: expect.any(Object),
      },
    );
  } finally {
    for (const key of testEnvKeys) {
      const value = previousEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    if (previousTestApi === undefined) {
      delete (globalThis as Record<PropertyKey, unknown>)[SESSION_WRITE_LOCK_TEST_API];
    } else {
      (globalThis as Record<PropertyKey, unknown>)[SESSION_WRITE_LOCK_TEST_API] = previousTestApi;
    }
    vi.resetModules();
  }
});
