import type { RuntimeEnv } from "openclaw/plugin-sdk/test-utils";
import { vi } from "vitest";

/**
 * Creates a minimal mock RuntimeEnv suitable for extension tests.
 *
 * - `log` and `error` are silent vi.fn() spies.
 * - `exit` throws so that any accidental call surfaces immediately in tests.
 */
export function createRuntimeEnv(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
  };
}
