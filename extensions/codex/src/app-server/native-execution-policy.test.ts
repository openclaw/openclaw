// Codex tests cover native execution policy plugin behavior.
import type { getSessionEntry as getSessionEntryType } from "openclaw/plugin-sdk/session-store-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCodexNativeExecutionPolicy } from "./native-execution-policy.js";

const sessionStoreMocks = vi.hoisted(() => ({
  getSessionEntry: vi.fn<typeof getSessionEntryType>(),
}));

vi.mock("openclaw/plugin-sdk/session-store-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/session-store-runtime")>();
  return {
    ...actual,
    getSessionEntry: sessionStoreMocks.getSessionEntry,
  };
});

describe("resolveCodexNativeExecutionPolicy", () => {
  beforeEach(() => {
    sessionStoreMocks.getSessionEntry.mockReset();
  });

  it("resolves auto to gateway when no sandbox is active", () => {
    expect(
      resolveCodexNativeExecutionPolicy({
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

  it("preserves a storage refusal instead of falling back to gateway execution", () => {
    const refusal = new Error("The selected session is no longer current");
    sessionStoreMocks.getSessionEntry.mockImplementation(() => {
      throw refusal;
    });
    expect(() =>
      resolveCodexNativeExecutionPolicy({
        config: { tools: { exec: { host: "gateway" } } },
        sessionKey: "agent:main:dashboard:incognito-refused",
        readRuntimeSessionEntry: true,
      }),
    ).toThrow(refusal);
  });

  it("honors persisted default-session exec hosts with explicit main agent policy", () => {
    sessionStoreMocks.getSessionEntry.mockReturnValue({
      sessionId: "session-1",
      updatedAt: 1,
      execHost: "node",
      execNode: "worker-5",
    });

    expect(
      resolveCodexNativeExecutionPolicy({
        config: { tools: { exec: { host: "gateway" } } },
        sessionKey: "main",
        agentId: "main",
        readRuntimeSessionEntry: true,
      }),
    ).toMatchObject({
      nativeToolSurfaceAllowed: false,
      requestedExecHost: "node",
      effectiveExecHost: "node",
      node: "worker-5",
    });
    expect(sessionStoreMocks.getSessionEntry).toHaveBeenCalledWith({
      sessionKey: "main",
      agentId: "main",
      hydrateSkillPromptRefs: false,
    });
  });

  it("does not read an unscoped session entry for an explicit multi-agent roster", () => {
    sessionStoreMocks.getSessionEntry.mockReturnValue({
      sessionId: "session-1",
      updatedAt: 1,
      execHost: "node",
      execNode: "worker-6",
    });

    expect(
      resolveCodexNativeExecutionPolicy({
        config: {
          tools: { exec: { host: "gateway" } },
          agents: { entries: { alpha: {}, beta: {} } },
        },
        sessionKey: "node-session",
        agentId: "alpha",
        readRuntimeSessionEntry: true,
      }),
    ).toMatchObject({
      nativeToolSurfaceAllowed: true,
      requestedExecHost: "gateway",
      effectiveExecHost: "gateway",
    });
    expect(sessionStoreMocks.getSessionEntry).not.toHaveBeenCalled();
  });

  it("uses global policy when an explicit multi-agent roster has no selected agent", () => {
    sessionStoreMocks.getSessionEntry.mockReturnValue({
      sessionId: "session-1",
      updatedAt: 1,
      execHost: "node",
      execNode: "worker-6",
    });

    expect(
      resolveCodexNativeExecutionPolicy({
        config: {
          tools: { exec: { host: "gateway" } },
          agents: { entries: { alpha: {}, beta: {} } },
        },
        sessionKey: "node-session",
        readRuntimeSessionEntry: true,
      }),
    ).toMatchObject({
      nativeToolSurfaceAllowed: true,
      requestedExecHost: "gateway",
      effectiveExecHost: "gateway",
    });
    expect(sessionStoreMocks.getSessionEntry).not.toHaveBeenCalled();
  });

  it("honors agent exec config before global exec config", () => {
    expect(
      resolveCodexNativeExecutionPolicy({
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
