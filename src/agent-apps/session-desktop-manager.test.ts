import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemorySessionDesktopManager } from "./session-desktop-manager.js";

describe("InMemorySessionDesktopManager", () => {
  let kernel: {
    createDesktop: ReturnType<typeof vi.fn>;
    destroyDesktop: ReturnType<typeof vi.fn>;
    suspend: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    kernel = {
      createDesktop: vi.fn(async (desktopId?: string) => desktopId ?? "dt_1"),
      destroyDesktop: vi.fn().mockResolvedValue(undefined),
      suspend: vi.fn().mockResolvedValue(undefined),
      resume: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("reuses the same desktop for the same canonical session key", async () => {
    const manager = new InMemorySessionDesktopManager(kernel as never);

    const first = await manager.ensureDesktop({
      sessionKey: "Agent:Main:Discord:Channel:Dev",
      sessionId: "session_1",
      agentId: "main",
    });
    const second = await manager.ensureDesktop({
      sessionKey: "agent:main:discord:channel:dev",
      sessionId: "session_2",
      agentId: "main",
    });

    expect(first.desktopId).toBe(second.desktopId);
    expect(second.sessionId).toBe("session_2");
    expect(kernel.createDesktop).toHaveBeenCalledTimes(1);
  });

  it("stores workspaceDir on create and refreshes it on reuse", async () => {
    const manager = new InMemorySessionDesktopManager(kernel as never);

    const first = await manager.ensureDesktop({
      sessionKey: "agent:main:discord:channel:dev",
      sessionId: "session_1",
      agentId: "main",
      workspaceDir: "/tmp/workspace-a",
    });

    const second = await manager.ensureDesktop({
      sessionKey: "agent:main:discord:channel:dev",
      sessionId: "session_2",
      agentId: "main",
      workspaceDir: "/tmp/workspace-b",
    });

    expect(first.workspaceDir).toBe("/tmp/workspace-b");
    expect(second.workspaceDir).toBe("/tmp/workspace-b");
  });

  it("extracts parent session key and thread id for thread sessions", async () => {
    const manager = new InMemorySessionDesktopManager(kernel as never);

    const record = await manager.ensureDesktop({
      sessionKey: "agent:main:discord:channel:dev:thread:release",
      agentId: "main",
    });

    expect(record.baseSessionKey).toBe("agent:main:discord:channel:dev");
    expect(record.threadId).toBe("release");
    expect(record.desktopId).toBe("agent:main:discord:channel:dev:thread:release");
  });

  it("destroys and recreates the desktop on reset", async () => {
    const manager = new InMemorySessionDesktopManager(kernel as never);

    const initial = await manager.ensureDesktop({
      sessionKey: "agent:main:discord:channel:dev",
      sessionId: "session_1",
      agentId: "reviewer",
      workspaceDir: "/tmp/workspace-a",
    });

    const next = await manager.resetDesktop("agent:main:discord:channel:dev", {
      sessionId: "session_2",
      reason: "reset",
    });

    expect(kernel.destroyDesktop).toHaveBeenCalledWith(initial.desktopId);
    expect(kernel.createDesktop).toHaveBeenCalledTimes(2);
    expect(next.sessionId).toBe("session_2");
    expect(next.agentId).toBe("reviewer");
    expect(next.workspaceDir).toBe("/tmp/workspace-a");
  });

  it("rolls back the desktop when post-create setup fails", async () => {
    const manager = new InMemorySessionDesktopManager(kernel as never, {
      afterCreate: async () => {
        throw new Error("install failed");
      },
    });

    await expect(
      manager.ensureDesktop({
        sessionKey: "agent:main:discord:channel:dev",
        agentId: "main",
      }),
    ).rejects.toThrow("install failed");

    expect(kernel.destroyDesktop).toHaveBeenCalledWith("agent:main:discord:channel:dev");
    expect(manager.getDesktop("agent:main:discord:channel:dev")).toBeUndefined();
  });

  it("shares an in-flight create and only publishes the desktop after post-create setup succeeds", async () => {
    let resolveAfterCreate: (() => void) | undefined;
    const manager = new InMemorySessionDesktopManager(kernel as never, {
      afterCreate: async () => {
        await new Promise<void>((resolve) => {
          resolveAfterCreate = resolve;
        });
      },
    });

    const firstPromise = manager.ensureDesktop({
      sessionKey: "agent:main:discord:channel:dev",
      sessionId: "session_1",
      agentId: "main",
    });
    const secondPromise = manager.ensureDesktop({
      sessionKey: "agent:main:discord:channel:dev",
      sessionId: "session_2",
      agentId: "main",
      workspaceDir: "/tmp/workspace-b",
    });

    expect(kernel.createDesktop).toHaveBeenCalledTimes(1);
    expect(manager.getDesktop("agent:main:discord:channel:dev")).toBeUndefined();

    await vi.waitFor(() => {
      expect(resolveAfterCreate).toBeTypeOf("function");
    });
    resolveAfterCreate?.();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.desktopId).toBe(second.desktopId);
    expect(second.sessionId).toBe("session_2");
    expect(second.workspaceDir).toBe("/tmp/workspace-b");
    expect(manager.getDesktop("agent:main:discord:channel:dev")).toBe(second);
  });
});
