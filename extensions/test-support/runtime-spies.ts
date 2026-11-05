import { vi } from "vitest";

export function createRuntimeSpies() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}
