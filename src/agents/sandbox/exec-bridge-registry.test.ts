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
  it("registers and looks up a bridge by session key", () => {
    const backend = fakeBackend();
    registerSandboxExecBridge("agent:test:session-1", backend);
    expect(getSandboxExecBridge("agent:test:session-1")).toBe(backend);
    pruneSandboxExecBridge("agent:test:session-1");
  });

  it("returns undefined for an unregistered session", () => {
    expect(getSandboxExecBridge("agent:test:never-registered")).toBeUndefined();
  });

  it("prune removes the entry", () => {
    registerSandboxExecBridge("agent:test:session-2", fakeBackend());
    pruneSandboxExecBridge("agent:test:session-2");
    expect(SANDBOX_EXEC_BRIDGES.has("agent:test:session-2")).toBe(false);
  });
});
