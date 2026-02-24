import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { vi } from "vitest";

export function createRuntimeEnv(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
  };
}
