// Codex tests cover native execution policy plugin behavior.
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  prepareCodexNativeExecutionPolicy,
  resolveCodexNativeExecutionPolicy,
} from "./native-execution-policy.js";

const sessionStoreMocks = vi.hoisted(() => ({
  captureSessionEntryCurrentCheckAsync: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/session-binding-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-binding-runtime")>();
  return {
    ...actual,
    captureSessionEntryCurrentCheckAsync: sessionStoreMocks.captureSessionEntryCurrentCheckAsync,
  };
});

function mockSelectedNodeEntry(execNode: string) {
  const release = vi.fn();
  sessionStoreMocks.captureSessionEntryCurrentCheckAsync.mockResolvedValue({
    entry: { sessionId: "session-1", updatedAt: 1, execHost: "node", execNode },
    isCurrent: async () => true,
    async assertCurrent() {},
    release,
  });
  onTestFinished(release);
}

describe("resolveCodexNativeExecutionPolicy", () => {
  beforeEach(() => {
    sessionStoreMocks.captureSessionEntryCurrentCheckAsync.mockReset();
  });

  it("resolves auto to gateway when no sandbox is active", () => {
    expect(
      resolveCodexNativeExecutionPolicy({
        sessionEntry: null,
        config: { tools: { exec: { host: "auto" } } },
        sessionKey: "session-1",
        sandboxAvailable: false,
      }),
    ).toMatchObject({
      nativeToolSurfaceAllowed: true,
      requestedExecHost: "auto",
      effectiveExecHost: "gateway",
    });
  });

  it("resolves auto to sandbox when a sandbox is active", () => {
    expect(
      resolveCodexNativeExecutionPolicy({
        sessionEntry: null,
        config: { tools: { exec: { host: "auto" } } },
        sessionKey: "session-1",
        sandboxAvailable: true,
      }),
    ).toMatchObject({
      nativeToolSurfaceAllowed: true,
      requestedExecHost: "auto",
      effectiveExecHost: "sandbox",
    });
  });

  it("honors per-attempt node exec overrides before config defaults", () => {
    expect(
      resolveCodexNativeExecutionPolicy({
        sessionEntry: null,
        config: { tools: { exec: { host: "gateway" } } },
        sessionKey: "session-1",
        execOverrides: { host: "node", node: "worker-2" },
      }),
    ).toMatchObject({
      nativeToolSurfaceAllowed: false,
      requestedExecHost: "node",
      effectiveExecHost: "node",
      node: "worker-2",
    });
  });

  it("preserves a storage refusal instead of falling back to gateway execution", async () => {
    const refusal = new Error("The selected session is no longer current");
    sessionStoreMocks.captureSessionEntryCurrentCheckAsync.mockImplementation(() => {
      throw refusal;
    });
    await expect(
      prepareCodexNativeExecutionPolicy({
        config: { tools: { exec: { host: "gateway" } } },
        sessionKey: "agent:main:dashboard:incognito-refused",
        readRuntimeSessionEntry: true,
      }),
    ).rejects.toThrow(refusal);
  });

  it("honors persisted default-session exec hosts with explicit main agent policy", async () => {
    mockSelectedNodeEntry("worker-5");

    expect(
      (
        await prepareCodexNativeExecutionPolicy({
          config: { tools: { exec: { host: "gateway" } } },
          sessionKey: "main",
          agentId: "main",
          readRuntimeSessionEntry: true,
        })
      ).policy,
    ).toMatchObject({
      nativeToolSurfaceAllowed: false,
      requestedExecHost: "node",
      effectiveExecHost: "node",
      node: "worker-5",
    });
    expect(sessionStoreMocks.captureSessionEntryCurrentCheckAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "main",
        agentId: "main",
      }),
    );
  });

  it("does not read an unscoped session entry for an explicit multi-agent roster", async () => {
    mockSelectedNodeEntry("worker-6");

    expect(
      (
        await prepareCodexNativeExecutionPolicy({
          config: {
            tools: { exec: { host: "gateway" } },
            agents: { entries: { alpha: {}, beta: {} } },
          },
          sessionKey: "node-session",
          agentId: "alpha",
          readRuntimeSessionEntry: true,
        })
      ).policy,
    ).toMatchObject({
      nativeToolSurfaceAllowed: true,
      requestedExecHost: "gateway",
      effectiveExecHost: "gateway",
    });
    expect(sessionStoreMocks.captureSessionEntryCurrentCheckAsync).not.toHaveBeenCalled();
  });

  it("uses global policy when an explicit multi-agent roster has no selected agent", async () => {
    mockSelectedNodeEntry("worker-6");

    expect(
      (
        await prepareCodexNativeExecutionPolicy({
          config: {
            tools: { exec: { host: "gateway" } },
            agents: { entries: { alpha: {}, beta: {} } },
          },
          sessionKey: "node-session",
          readRuntimeSessionEntry: true,
        })
      ).policy,
    ).toMatchObject({
      nativeToolSurfaceAllowed: true,
      requestedExecHost: "gateway",
      effectiveExecHost: "gateway",
    });
    expect(sessionStoreMocks.captureSessionEntryCurrentCheckAsync).not.toHaveBeenCalled();
  });

  it("honors agent exec config before global exec config", () => {
    expect(
      resolveCodexNativeExecutionPolicy({
        sessionEntry: null,
        config: {
          tools: { exec: { host: "gateway" } },
          agents: {
            entries: { main: { tools: { exec: { host: "node", node: "worker-4" } } } },
          },
        },
        sessionKey: "agent:main:session-1",
      }),
    ).toMatchObject({
      nativeToolSurfaceAllowed: false,
      requestedExecHost: "node",
      effectiveExecHost: "node",
      node: "worker-4",
    });
  });
});
