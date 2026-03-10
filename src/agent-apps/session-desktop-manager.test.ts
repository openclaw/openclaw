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

  it("attempts to destroy every desktop and aggregates failures", async () => {
    const manager = new InMemorySessionDesktopManager(kernel as never);
    await manager.ensureDesktop({
      sessionKey: "agent:main:discord:channel:one",
      agentId: "main",
    });
    await manager.ensureDesktop({
      sessionKey: "agent:main:discord:channel:two",
      agentId: "main",
    });
    kernel.destroyDesktop.mockImplementation(async (desktopId?: string) => {
      if (desktopId === "agent:main:discord:channel:one") {
        throw new Error("destroy failed");
      }
    });

    await expect(manager.destroyAll("shutdown")).rejects.toThrow(
      "destroyAll failed for 1 desktop(s)",
    );

    expect(kernel.destroyDesktop).toHaveBeenCalledTimes(2);
    expect(manager.getDesktop("agent:main:discord:channel:one")).toBeDefined();
    expect(manager.getDesktop("agent:main:discord:channel:two")).toBeUndefined();
  });

  it("resets a desktop that is still being created instead of rebinding the first create result", async () => {
    let resolveAfterCreate: (() => void) | undefined;
    let afterCreateCalls = 0;
    kernel.createDesktop.mockResolvedValueOnce("dt_initial").mockResolvedValueOnce("dt_reset");
    const manager = new InMemorySessionDesktopManager(kernel as never, {
      afterCreate: async () => {
        afterCreateCalls += 1;
        if (afterCreateCalls > 1) {
          return;
        }
        await new Promise<void>((resolve) => {
          resolveAfterCreate = resolve;
        });
      },
    });

    const createPromise = manager.ensureDesktop({
      sessionKey: "agent:main:discord:channel:dev",
      sessionId: "session_1",
      agentId: "main",
    });
    const resetPromise = manager.resetDesktop("agent:main:discord:channel:dev", {
      sessionId: "session_2",
      reason: "reset",
    });

    await vi.waitFor(() => {
      expect(resolveAfterCreate).toBeTypeOf("function");
    });
    resolveAfterCreate?.();

    const created = await createPromise;
    const reset = await resetPromise;

    expect(created.desktopId).toBe("dt_initial");
    expect(kernel.destroyDesktop).toHaveBeenCalledWith("dt_initial");
    expect(reset.desktopId).toBe("dt_reset");
    expect(reset.sessionId).toBe("session_2");
    expect(manager.getDesktop("agent:main:discord:channel:dev")?.desktopId).toBe("dt_reset");
  });

  it("retries after a shared pending create fails", async () => {
    let createCalls = 0;
    kernel.createDesktop.mockImplementation(async () => {
      createCalls += 1;
      return createCalls === 1 ? "dt_failed" : "dt_retried";
    });
    let afterCreateCalls = 0;
    const manager = new InMemorySessionDesktopManager(kernel as never, {
      afterCreate: async () => {
        afterCreateCalls += 1;
        if (afterCreateCalls === 1) {
          throw new Error("install failed");
        }
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
    });

    await expect(firstPromise).rejects.toThrow("install failed");
    const second = await secondPromise;

    expect(kernel.destroyDesktop).toHaveBeenCalledWith("dt_failed");
    expect(kernel.createDesktop).toHaveBeenCalledTimes(2);
    expect(second.desktopId).toBe("dt_retried");
    expect(second.sessionId).toBe("session_2");
    expect(manager.getDesktop("agent:main:discord:channel:dev")?.desktopId).toBe("dt_retried");
  });

  it("fails with bounded retries when shared pending create keeps failing", async () => {
    let createCalls = 0;
    kernel.createDesktop.mockImplementation(async () => {
      createCalls += 1;
      return `dt_failed_${createCalls}`;
    });
    const manager = new InMemorySessionDesktopManager(kernel as never, {
      afterCreate: async () => {
        throw new Error("install failed");
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
    });

    await expect(firstPromise).rejects.toThrow("install failed");
    await expect(secondPromise).rejects.toThrow();
    expect(kernel.createDesktop).toHaveBeenCalledTimes(2);
  });
});
