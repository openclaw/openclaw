import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { vi } from "vitest";
import { createCliRuntimeCapture } from "../../test-support.js";

export function createBrowserCliCapture() {
  const { defaultRuntime: runtime, resetRuntimeCapture } = createCliRuntimeCapture();
  return {
    runtime,
    resetRuntimeCapture,
    installRuntime: () => ({
      json: vi.spyOn(defaultRuntime, "writeJson").mockImplementation(runtime.writeJson),
      log: vi.spyOn(defaultRuntime, "log").mockImplementation(runtime.log),
      error: vi.spyOn(defaultRuntime, "error").mockImplementation(runtime.error),
      exit: vi.spyOn(defaultRuntime, "exit").mockImplementation(runtime.exit),
    }),
  };
}
