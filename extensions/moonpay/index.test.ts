import { describe, expect, it, vi, beforeEach } from "vitest";
import { extractPositionals, isBlocked } from "./index.js";

// Mock child_process before importing the module that uses it at top level
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import moonpayPlugin from "./index.js";
import { runMp } from "./index.js";

// Helper to create a minimal fake plugin API
function fakeApi(overrides: Record<string, unknown> = {}) {
  return {
    id: "moonpay",
    name: "MoonPay",
    description: "test",
    source: "test",
    config: {},
    pluginConfig: {},
    runtime: {} as never,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    registerTool: vi.fn(),
    registerHook() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli: vi.fn(),
    registerService() {},
    registerProvider() {},
    registerCommand() {},
    resolvePath: (input: string) => input,
    on() {},
    ...overrides,
  };
}

describe("extractPositionals", () => {
  it("extracts simple command and subcommand", () => {
    expect(extractPositionals(["wallet", "list"])).toEqual({ cmd: "wallet", sub: "list" });
  });

  it("skips leading flags", () => {
    expect(extractPositionals(["--verbose", "wallet", "list"])).toEqual({
      cmd: "wallet",
      sub: "list",
    });
  });

  it("skips flags with = values", () => {
    expect(extractPositionals(["--timeout=30", "consent"])).toEqual({
      cmd: "consent",
      sub: undefined,
    });
  });

  it("returns undefined for empty args", () => {
    expect(extractPositionals([])).toEqual({ cmd: undefined, sub: undefined });
  });

  it("stops at -- separator", () => {
    expect(extractPositionals(["--", "wallet", "list"])).toEqual({
      cmd: undefined,
      sub: undefined,
    });
  });
});

describe("isBlocked", () => {
  it("blocks top-level consent command", () => {
    expect(isBlocked(["consent"])).toContain("consent");
  });

  it("blocks top-level skill command", () => {
    expect(isBlocked(["skill"])).toContain("skill");
  });

  it("blocks wallet delete", () => {
    expect(isBlocked(["wallet", "delete"])).toContain("wallet delete");
  });

  it("blocks wallet export", () => {
    expect(isBlocked(["wallet", "export"])).toContain("wallet export");
  });

  it("allows wallet list", () => {
    expect(isBlocked(["wallet", "list"])).toBeUndefined();
  });

  it("blocks consent even with leading flags", () => {
    expect(isBlocked(["--verbose", "consent"])).toContain("consent");
  });

  it("blocks wallet delete with leading flags", () => {
    expect(isBlocked(["--timeout=30", "wallet", "delete", "--confirm"])).toContain("wallet delete");
  });

  it("allows normal commands", () => {
    expect(isBlocked(["token", "balance", "list"])).toBeUndefined();
  });
});

describe("runMp", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves with stdout/stderr/exitCode on success", async () => {
    vi.mocked(execFile).mockImplementation(
      // oxlint-disable-next-line typescript/no-explicit-any
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(null, "v1.0.0\n", "");
        return undefined as never;
      },
    );
    const result = await runMp(["--version"]);
    expect(result).toEqual({ stdout: "v1.0.0\n", stderr: "", exitCode: 0 });
  });

  it("returns exitCode 1 for ENOENT (binary not found)", async () => {
    vi.mocked(execFile).mockImplementation(
      // oxlint-disable-next-line typescript/no-explicit-any
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        const err = new Error("spawn mp ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        cb(err, "", "");
        return undefined as never;
      },
    );
    const result = await runMp(["--version"]);
    expect(result.exitCode).toBe(1);
  });

  it("returns exit status from error when available", async () => {
    vi.mocked(execFile).mockImplementation(
      // oxlint-disable-next-line typescript/no-explicit-any
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        const err = new Error("command failed") as NodeJS.ErrnoException & { status: number };
        err.status = 2;
        cb(err, "", "auth required\n");
        return undefined as never;
      },
    );
    const result = await runMp(["user", "retrieve"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("auth required\n");
  });
});

describe("moonpay plugin registration", () => {
  beforeEach(() => vi.clearAllMocks());

  it("registers CLI commands immediately", () => {
    // Make the mp --version check succeed
    vi.mocked(execFile).mockImplementation(
      // oxlint-disable-next-line typescript/no-explicit-any
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(null, "v1.0.0", "");
        return undefined as never;
      },
    );
    const api = fakeApi();
    moonpayPlugin.register(api as never);
    expect(api.registerCli).toHaveBeenCalledTimes(1);
  });

  it("registers tool when mp binary is available", async () => {
    vi.mocked(execFile).mockImplementation(
      // oxlint-disable-next-line typescript/no-explicit-any
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(null, "v1.0.0", "");
        return undefined as never;
      },
    );
    const api = fakeApi();
    moonpayPlugin.register(api as never);
    // Wait for the async mp availability check to resolve
    await vi.waitFor(() => expect(api.registerTool).toHaveBeenCalledTimes(1));
  });

  it("does not register tool when mp binary is missing", async () => {
    vi.mocked(execFile).mockImplementation(
      // oxlint-disable-next-line typescript/no-explicit-any
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        cb(err, "", "");
        return undefined as never;
      },
    );
    const api = fakeApi();
    moonpayPlugin.register(api as never);
    // Give the promise time to settle
    await new Promise((r) => setTimeout(r, 50));
    expect(api.registerTool).not.toHaveBeenCalled();
  });

  it("has correct plugin metadata", () => {
    expect(moonpayPlugin.id).toBe("moonpay");
    expect(moonpayPlugin.name).toBe("MoonPay");
    expect(moonpayPlugin.configSchema).toBeDefined();
  });
});
