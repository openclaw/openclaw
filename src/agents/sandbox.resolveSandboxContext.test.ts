import { describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../config/config.js";

describe("resolveSandboxContext", () => {
  it("does not sandbox the agent main session in non-main mode", async () => {
    vi.resetModules();

    const spawn = vi.fn(() => {
      throw new Error("spawn should not be called");
    });
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("node:child_process")>();
      return { ...actual, spawn };
    });

    const { resolveSandboxContext } = await import("./sandbox.js");

    const cfg: ClawdbotConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "non-main", scope: "session" },
        },
        list: [{ id: "main" }],
      },
    };

    const result = await resolveSandboxContext({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/clawdbot-test",
    });

    expect(result).toBeNull();
    expect(spawn).not.toHaveBeenCalled();

    vi.doUnmock("node:child_process");
  }, 15_000);

  it("does not create a sandbox workspace for the agent main session in non-main mode", async () => {
    vi.resetModules();

    const spawn = vi.fn(() => {
      throw new Error("spawn should not be called");
    });
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("node:child_process")>();
      return { ...actual, spawn };
    });

    const { ensureSandboxWorkspaceForSession } = await import("./sandbox.js");

    const cfg: ClawdbotConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "non-main", scope: "session" },
        },
        list: [{ id: "main" }],
      },
    };

    const result = await ensureSandboxWorkspaceForSession({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/clawdbot-test",
    });

    expect(result).toBeNull();
    expect(spawn).not.toHaveBeenCalled();

    vi.doUnmock("node:child_process");
  }, 15_000);
});
