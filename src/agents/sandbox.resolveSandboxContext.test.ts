import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { registerSandboxBackend } from "./sandbox/backend.js";
import { ensureSandboxWorkspaceForSession, resolveSandboxContext } from "./sandbox/context.js";
import { resolveSandboxRuntimeStatus } from "./sandbox/runtime-status.js";

describe("resolveSandboxContext", () => {
  it("does not sandbox the agent main session in non-main mode", async () => {
    const cfg: OpenClawConfig = {
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
      workspaceDir: "/tmp/openclaw-test",
    });

    expect(result).toBeNull();
  }, 15_000);

  it("does not create a sandbox workspace for the agent main session in non-main mode", async () => {
    const cfg: OpenClawConfig = {
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
      workspaceDir: "/tmp/openclaw-test",
    });

    expect(result).toBeNull();
  }, 15_000);

  it("treats main session aliases as main in non-main mode", async () => {
    const cfg: OpenClawConfig = {
      session: { mainKey: "work" },
      agents: {
        defaults: {
          sandbox: { mode: "non-main", scope: "session" },
        },
        list: [{ id: "main" }],
      },
    };

    expect(
      await resolveSandboxContext({
        config: cfg,
        sessionKey: "main",
        workspaceDir: "/tmp/openclaw-test",
      }),
    ).toBeNull();

    expect(
      await resolveSandboxContext({
        config: cfg,
        sessionKey: "agent:main:main",
        workspaceDir: "/tmp/openclaw-test",
      }),
    ).toBeNull();

    expect(
      await ensureSandboxWorkspaceForSession({
        config: cfg,
        sessionKey: "work",
        workspaceDir: "/tmp/openclaw-test",
      }),
    ).toBeNull();

    expect(
      await ensureSandboxWorkspaceForSession({
        config: cfg,
        sessionKey: "agent:main:main",
        workspaceDir: "/tmp/openclaw-test",
      }),
    ).toBeNull();
  }, 15_000);

  it("forces sandbox runtime status for all sessions in private mode", () => {
    const cfg: OpenClawConfig = {
      privateMode: {
        enabled: true,
        execution: {
          sandboxMode: "all",
        },
      },
      agents: {
        defaults: {
          sandbox: { mode: "off", scope: "session" },
        },
        list: [{ id: "main" }],
      },
    };

    const runtime = resolveSandboxRuntimeStatus({
      cfg,
      sessionKey: "agent:main:main",
    });

    expect(runtime.mode).toBe("all");
    expect(runtime.forcedByPrivateMode).toBe(true);
    expect(runtime.sandboxed).toBe(true);
  });

  it("creates sandbox context for the main session when private mode forces sandboxing", async () => {
    const restore = registerSandboxBackend("test-backend", async () => ({
      id: "test-backend",
      runtimeId: "test-runtime-private-mode",
      runtimeLabel: "Test Runtime",
      workdir: "/workspace",
      buildExecSpec: async () => ({
        argv: ["test-backend", "exec"],
        env: process.env,
        stdinMode: "pipe-closed",
      }),
      runShellCommand: async () => ({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        code: 0,
      }),
    }));
    try {
      const cfg: OpenClawConfig = {
        privateMode: {
          enabled: true,
          execution: {
            sandboxMode: "all",
            blockHostExec: true,
          },
        },
        agents: {
          defaults: {
            sandbox: { mode: "off", backend: "test-backend", scope: "session" },
          },
          list: [{ id: "main" }],
        },
      };

      const result = await resolveSandboxContext({
        config: cfg,
        sessionKey: "agent:main:main",
        workspaceDir: "/tmp/openclaw-test-private-mode",
      });

      expect(result?.enabled).toBe(true);
      expect(result?.backendId).toBe("test-backend");
      expect(result?.runtimeId).toBe("test-runtime-private-mode");
    } finally {
      restore();
    }
  }, 15_000);

  it("resolves a registered non-docker backend", async () => {
    const restore = registerSandboxBackend("test-backend", async () => ({
      id: "test-backend",
      runtimeId: "test-runtime",
      runtimeLabel: "Test Runtime",
      workdir: "/workspace",
      buildExecSpec: async () => ({
        argv: ["test-backend", "exec"],
        env: process.env,
        stdinMode: "pipe-closed",
      }),
      runShellCommand: async () => ({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        code: 0,
      }),
    }));
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            sandbox: { mode: "all", backend: "test-backend", scope: "session" },
          },
        },
      };

      const result = await resolveSandboxContext({
        config: cfg,
        sessionKey: "agent:worker:task",
        workspaceDir: "/tmp/openclaw-test",
      });

      expect(result?.backendId).toBe("test-backend");
      expect(result?.runtimeId).toBe("test-runtime");
      expect(result?.containerName).toBe("test-runtime");
      expect(result?.backend?.id).toBe("test-backend");
    } finally {
      restore();
    }
  }, 15_000);
});
