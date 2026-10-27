import { vi } from "vitest";

// A redirect mock stays mocked during concurrent dynamic catalog imports.
export const codexControlRequest = vi.fn();
