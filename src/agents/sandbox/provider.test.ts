import { describe, it, expect } from "vitest";
import type {
  ISandboxProvider,
  SandboxBackend,
  ProviderHealthResult,
  ExecResult,
  SandboxState,
  EnsureSandboxParams,
  ExecOptions,
  DestroyOptions,
  SandboxInfo,
} from "./provider.js";
import type { SandboxConfig } from "./types.js";

describe("ISandboxProvider interface contract", () => {
  it("can be satisfied by an object with all required methods", () => {
    const mock: ISandboxProvider = {
      name: "docker",
      checkHealth: async () => ({ available: true, message: "ok" }),
      ensureSandbox: async () => "container-1",
      exec: async () => ({
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        code: 0,
      }),
      destroy: async () => {},
      status: async () => ({ exists: true, running: true }),
      list: async () => [],
    };
    expect(mock.name).toBe("docker");
    expect(typeof mock.checkHealth).toBe("function");
    expect(typeof mock.ensureSandbox).toBe("function");
    expect(typeof mock.exec).toBe("function");
    expect(typeof mock.destroy).toBe("function");
    expect(typeof mock.status).toBe("function");
    expect(typeof mock.list).toBe("function");
  });

  it("SandboxBackend accepts valid values", () => {
    const values: SandboxBackend[] = ["auto", "docker", "gvisor", "firecracker"];
    expect(values).toHaveLength(4);
    for (const v of values) {
      expect(typeof v).toBe("string");
    }
  });

  it("ProviderHealthResult has correct shape", () => {
    const healthy: ProviderHealthResult = {
      available: true,
      message: "Docker daemon is running",
      version: "Docker 24.0.7",
    };
    expect(healthy.available).toBe(true);
    expect(typeof healthy.message).toBe("string");
    expect(typeof healthy.version).toBe("string");

    const unhealthy: ProviderHealthResult = {
      available: false,
      message: "Docker not found",
    };
    expect(unhealthy.available).toBe(false);
    expect(unhealthy.version).toBeUndefined();
  });

  it("ExecResult has stdout (Buffer), stderr (Buffer), code (number)", () => {
    const result: ExecResult = {
      stdout: Buffer.from("hello"),
      stderr: Buffer.from(""),
      code: 0,
    };
    expect(Buffer.isBuffer(result.stdout)).toBe(true);
    expect(Buffer.isBuffer(result.stderr)).toBe(true);
    expect(typeof result.code).toBe("number");
  });

  it("SandboxState has exists and running booleans", () => {
    const state: SandboxState = { exists: true, running: false };
    expect(typeof state.exists).toBe("boolean");
    expect(typeof state.running).toBe("boolean");
  });

  it("EnsureSandboxParams has required fields", () => {
    const cfg = {
      mode: "all",
      scope: "session",
      workspaceAccess: "rw",
      workspaceRoot: "/workspace",
      docker: { image: "node:20" },
      browser: { enabled: false },
      tools: { allow: ["*"], deny: [] },
      prune: { idleHours: 24, maxAgeDays: 7 },
      backend: "auto",
    } as unknown as SandboxConfig;

    const params: EnsureSandboxParams = {
      sessionKey: "sess-123",
      workspaceDir: "/workspace",
      agentWorkspaceDir: "/agent",
      cfg,
    };
    expect(params.sessionKey).toBe("sess-123");
    expect(params.cfg.backend).toBe("auto");
  });

  it("ExecOptions and DestroyOptions are optional and well-typed", () => {
    const execOpts: ExecOptions = {
      timeout: 30000,
      cwd: "/tmp",
      env: { PATH: "/usr/bin" },
      allowFailure: true,
    };
    expect(execOpts.timeout).toBe(30000);

    const destroyOpts: DestroyOptions = { force: true };
    expect(destroyOpts.force).toBe(true);

    const emptyExec: ExecOptions = {};
    expect(emptyExec.timeout).toBeUndefined();

    const emptyDestroy: DestroyOptions = {};
    expect(emptyDestroy.force).toBeUndefined();
  });

  it("SandboxInfo has containerName and running", () => {
    const info: SandboxInfo = {
      containerName: "sandbox-abc",
      sessionKey: "sess-1",
      running: true,
      image: "node:20",
    };
    expect(info.containerName).toBe("sandbox-abc");
    expect(info.running).toBe(true);

    const minimal: SandboxInfo = {
      containerName: "sandbox-xyz",
      running: false,
    };
    expect(minimal.sessionKey).toBeUndefined();
    expect(minimal.image).toBeUndefined();
  });

  it("ISandboxProvider.name excludes 'auto'", () => {
    // Type-level: "auto" is excluded from provider name.
    // This verifies the Exclude<SandboxBackend, "auto"> works.
    const validNames: Array<Exclude<SandboxBackend, "auto">> = ["docker", "gvisor", "firecracker"];
    expect(validNames).toHaveLength(3);
    expect(validNames).not.toContain("auto");
  });
});
