import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecApprovalsResolved } from "../infra/exec-approvals.js";
import { captureEnv } from "../test-utils/env.js";
import { sanitizeBinaryOutput } from "./shell-utils.js";

const isWin = process.platform === "win32";
const FOREGROUND_TEST_YIELD_MS = 120_000;
const EXEC_DEFAULTS = { host: "gateway", security: "full", ask: "off" } as const;
const ENV_KEYS = ["OPENCLAW_EXEC_SHELL_SNAPSHOT", "PATH", "SHELL", "SSLKEYLOGFILE"] as const;
type GetShellPathFromLoginShell = typeof import("../infra/shell-env.js").getShellPathFromLoginShell;
const shellEnvMocks = vi.hoisted(() => ({
  getShellPathFromLoginShell: vi.fn<GetShellPathFromLoginShell>(() => "/custom/bin:/opt/bin"),
  resolveShellEnvFallbackTimeoutMs: vi.fn(() => 1234),
}));

vi.mock("../infra/shell-env.js", async () => {
  const mod =
    await vi.importActual<typeof import("../infra/shell-env.js")>("../infra/shell-env.js");
  return {
    ...mod,
    getShellPathFromLoginShell: shellEnvMocks.getShellPathFromLoginShell,
    resolveShellEnvFallbackTimeoutMs: shellEnvMocks.resolveShellEnvFallbackTimeoutMs,
  };
});

vi.mock("../infra/exec-approvals.js", async () => {
  const mod = await vi.importActual<typeof import("../infra/exec-approvals.js")>(
    "../infra/exec-approvals.js",
  );
  return {
    ...mod,
    resolveExecApprovals: () => createExecApprovals(),
    resolveExecApprovalsLocked: async () => createExecApprovals(),
  };
});

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: async (input: {
      argv?: string[];
      env?: NodeJS.ProcessEnv;
      onStdout?: (chunk: string) => void;
    }) => {
      const command = input.argv?.at(-1) ?? "";
      const env = input.env ?? {};
      if (command.includes("GIT_PAGER")) {
        input.onStdout?.(JSON.stringify({ GIT_PAGER: env.GIT_PAGER, PAGER: env.PAGER }));
      } else if (command.includes("SSLKEYLOGFILE")) {
        input.onStdout?.(env.SSLKEYLOGFILE ?? "");
      } else if (command.includes("$PATH")) {
        input.onStdout?.(env.PATH ?? "");
      } else if (command.includes("echo ok")) {
        input.onStdout?.("ok\n");
      }
      return {
        activity: { resultSettled: true, lastOutputAtMs: Date.now() },
        runId: "mock-path-run",
        startedAtMs: Date.now(),
        stdin: undefined,
        wait: async () => ({
          reason: "exit" as const,
          exitCode: 0,
          exitSignal: null,
          durationMs: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          noOutputTimedOut: false,
        }),
        cancel: vi.fn(),
      };
    },
    cancel: vi.fn(),
    cancelScope: vi.fn(),
  }),
}));

let createExecTool: typeof import("./bash-tools.exec-run.js").createExecTool;
type ExecParams = Parameters<ReturnType<typeof createExecTool>["execute"]>[1];
const execute = (params: ExecParams) =>
  createExecTool(EXEC_DEFAULTS).execute("exec", {
    yieldMs: FOREGROUND_TEST_YIELD_MS,
    ...params,
  });

function createExecApprovals(): ExecApprovalsResolved {
  const policy = {
    security: "full" as const,
    ask: "off" as const,
    askFallback: "full" as const,
    autoAllowSkills: false,
  };
  return {
    path: "/tmp/exec-approvals.json",
    socketPath: "/tmp/exec-approvals.sock",
    token: "token",
    defaults: { ...policy },
    agent: { ...policy },
    agentSources: {
      security: "defaults.security",
      ask: "defaults.ask",
      askFallback: "defaults.askFallback",
    },
    allowlist: [],
    file: {
      version: 1,
      socket: { path: "/tmp/exec-approvals.sock", token: "token" },
      defaults: { ...policy },
      agents: {},
    },
  };
}

const normalizeText = (value?: string) =>
  sanitizeBinaryOutput(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

function normalizePathEntries(value?: string): string[] {
  return normalizeText(value)
    .split(/[:\s]+/)
    .filter(Boolean);
}

describe("exec PATH login shell merge", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeAll(async () => {
    ({ createExecTool } = await import("./bash-tools.exec-run.js"));
  });

  afterAll(() => {
    vi.doUnmock("../infra/shell-env.js");
    vi.doUnmock("../infra/exec-approvals.js");
    vi.doUnmock("../process/supervisor/index.js");
    vi.resetModules();
  });

  beforeEach(() => {
    envSnapshot = captureEnv([...ENV_KEYS]);
    process.env.OPENCLAW_EXEC_SHELL_SNAPSHOT = "0";
    shellEnvMocks.getShellPathFromLoginShell.mockReset();
    shellEnvMocks.getShellPathFromLoginShell.mockReturnValue("/custom/bin:/opt/bin");
    shellEnvMocks.resolveShellEnvFallbackTimeoutMs.mockReset();
    shellEnvMocks.resolveShellEnvFallbackTimeoutMs.mockReturnValue(1234);
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("strips malformed XML arg-value suffixes from exec command and routing options", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-exec-xml-"));
    try {
      const tool = createExecTool(EXEC_DEFAULTS);
      const malformedArgs = {
        command: "echo ok</arg_value>>",
        workdir: `${tempDir}</arg_value>>`,
        host: "gateway</arg_value>>",
        ask: "off</arg_value>>",
        node: "ignored-node</arg_value>>",
        yieldMs: FOREGROUND_TEST_YIELD_MS,
      } as unknown as Parameters<typeof tool.execute>[1];
      const prepared = await tool.prepareBeforeToolCallParams?.(malformedArgs, {});
      expect(prepared).toMatchObject({
        command: "echo ok",
        workdir: tempDir,
        host: "gateway",
        ask: "off",
        node: "ignored-node",
      });
      const result = await tool.execute("call-xml-suffix", malformedArgs);
      const value = normalizeText(result.content.find((c) => c.type === "text")?.text);

      expect(value).toBe("ok");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects the unsupported cwd alias before command execution", async () => {
    // `cwd` is dropped by the schema, so a stale caller runs in the tool default instead.
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    await expect(
      tool.execute("call-cwd-alias", {
        command: "echo ok",
        cwd: os.tmpdir(),
        yieldMs: FOREGROUND_TEST_YIELD_MS,
      } as never),
    ).rejects.toThrow('exec parameter "cwd" is unsupported; use "workdir" instead');
  });

  it("merges login-shell PATH for host=gateway", async () => {
    if (isWin) {
      return;
    }
    process.env.PATH = "/usr/bin";

    const shellPathMock = shellEnvMocks.getShellPathFromLoginShell;
    shellPathMock.mockClear();
    shellPathMock.mockReturnValue("/custom/bin:/opt/bin");

    const result = await execute({
      command: "echo $PATH",
    });
    const entries = normalizePathEntries(result.content.find((c) => c.type === "text")?.text);

    expect(entries).toEqual(["/custom/bin", "/opt/bin", "/usr/bin"]);
    expect(shellPathMock).toHaveBeenCalledTimes(1);
  });

  it("throws security violation when env.PATH is provided", async () => {
    if (isWin) {
      return;
    }
    process.env.PATH = "/usr/bin";

    const shellPathMock = shellEnvMocks.getShellPathFromLoginShell;
    shellPathMock.mockClear();

    await expect(
      execute({
        command: "echo $PATH",
        env: { PATH: "/explicit/bin" },
      }),
    ).rejects.toThrow(/Security Violation: Custom 'PATH' variable is forbidden/);

    expect(shellPathMock).not.toHaveBeenCalled();
  });

  it("runs exact no-pager requests with empty rather than executable pager values", async () => {
    const result = await execute({
      command: "echo GIT_PAGER PAGER",
      env: { GIT_PAGER: "cat", PAGER: "cat" },
    });
    expect(normalizeText(result.content.find((c) => c.type === "text")?.text)).toBe(
      JSON.stringify({ GIT_PAGER: "", PAGER: "" }),
    );
  });

  it("does not apply login-shell PATH when probe rejects unregistered absolute SHELL", async () => {
    if (isWin) {
      return;
    }
    process.env.PATH = "/usr/bin";
    const shellDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-shell-env-"));
    const unregisteredShellPath = path.join(shellDir, "unregistered-shell");
    fs.writeFileSync(unregisteredShellPath, '#!/bin/sh\nexec /bin/sh "$@"\n', {
      encoding: "utf8",
      mode: 0o755,
    });
    process.env.SHELL = unregisteredShellPath;

    try {
      const shellPathMock = shellEnvMocks.getShellPathFromLoginShell;
      shellPathMock.mockClear();
      shellPathMock.mockImplementation((opts) =>
        opts.env.SHELL?.trim() === unregisteredShellPath ? null : "/custom/bin:/opt/bin",
      );

      const result = await execute({
        command: "echo $PATH",
      });
      const entries = normalizePathEntries(result.content.find((c) => c.type === "text")?.text);

      expect(entries).toEqual(["/usr/bin"]);
      expect(shellPathMock).toHaveBeenCalledTimes(1);
      const shellPathCall = shellPathMock.mock.calls.at(0)?.[0];
      expect(shellPathCall?.env).toBe(process.env);
      expect(shellPathCall?.timeoutMs).toBe(1234);
    } finally {
      fs.rmSync(shellDir, { recursive: true, force: true });
    }
  });
});

describe("exec host env validation", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv([...ENV_KEYS]);
    process.env.OPENCLAW_EXEC_SHELL_SNAPSHOT = "0";
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("blocks LD_/DYLD_ env vars on host execution", async () => {
    await expect(
      execute({
        command: "echo ok",
        env: { LD_DEBUG: "1" },
      }),
    ).rejects.toThrow(/Security Violation: Environment variable 'LD_DEBUG' is forbidden/);
  });

  it("blocks proxy and TLS override env vars on host execution", async () => {
    await expect(
      execute({
        command: "echo ok",
        env: {
          HTTPS_PROXY: "http://proxy.example.test:8080",
          NODE_TLS_REJECT_UNAUTHORIZED: "0",
        },
      }),
    ).rejects.toThrow(
      /Security Violation: blocked override keys: HTTPS_PROXY, NODE_TLS_REJECT_UNAUTHORIZED\./,
    );
  });

  it("strips dangerous inherited env vars from host execution", async () => {
    if (isWin) {
      return;
    }
    process.env.SSLKEYLOGFILE = "/tmp/openclaw-ssl-keys.log";
    const result = await execute({
      command: "printf '%s' \"${SSLKEYLOGFILE:-}\"",
    });
    const output = normalizeText(result.content.find((c) => c.type === "text")?.text);
    expect(output).not.toContain("/tmp/openclaw-ssl-keys.log");
  });

  it("fails closed when sandbox host is explicitly configured without sandbox runtime", async () => {
    const tool = createExecTool({ host: "sandbox", security: "full", ask: "off" });

    await expect(
      tool.execute("call1", {
        command: "echo ok",
      }),
    ).rejects.toThrow(/requires a sandbox runtime/);
  });

  it("rejects /approve nested in shell wrappers", async () => {
    await expect(
      execute({
        command: "sudo -u root OPENCLAW_APPROVE=1 bash -lc '/approve abc123 allow-once'",
      }),
    ).rejects.toThrow(/exec cannot run \/approve commands/);
  });
});
