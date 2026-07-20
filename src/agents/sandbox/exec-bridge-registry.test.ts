import { describe, expect, it } from "vitest";
import type { SandboxBackendHandle } from "./backend-handle.types.js";
import {
  getSandboxExecBridge,
  pruneSandboxExecBridge,
  registerSandboxExecBridge,
  SANDBOX_EXEC_BRIDGES,
} from "./exec-bridge-registry.js";

function fakeBackend(): SandboxBackendHandle {
  return {
    runShellCommand: async () => ({ stdout: Buffer.from(""), stderr: Buffer.from(""), code: 0 }),
  } as unknown as SandboxBackendHandle;
}

describe("exec-bridge-registry", () => {
  it("registers and looks up a bridge by container key", () => {
    const backend = fakeBackend();
    registerSandboxExecBridge("openclaw-sbx-container-1", backend);
    expect(getSandboxExecBridge("openclaw-sbx-container-1")).toBe(backend);
    pruneSandboxExecBridge("openclaw-sbx-container-1");
  });

  it("returns undefined for an unregistered container", () => {
    expect(getSandboxExecBridge("openclaw-sbx-never-registered")).toBeUndefined();
  });

  it("prune removes the entry", () => {
    registerSandboxExecBridge("openclaw-sbx-container-2", fakeBackend());
    pruneSandboxExecBridge("openclaw-sbx-container-2");
    expect(SANDBOX_EXEC_BRIDGES.has("openclaw-sbx-container-2")).toBe(false);
  });
});
