import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecApprovalsResolved } from "../infra/exec-approvals.js";
import { captureEnv } from "../test-utils/env.js";
import { buildDockerExecArgs } from "./bash-tools.shared.js";
import { sanitizeBinaryOutput } from "./shell-utils.js";

const isWin = process.platform === "win32";
type GetShellPathFromLoginShell = typeof import("../infra/shell-env.js").getShellPathFromLoginShell;
const shellEnvMocks = vi.hoisted(() => ({
  getShellPathFromLoginShell: vi.fn<GetShellPathFromLoginShell>(() => "/custom/bin:/opt/bin"),
  resolveShellEnvFallbackTimeoutMs: vi.fn(() => 1234),
}));
const execApprovalsMocks = vi.hoisted(() => ({
  resolveExecApprovals:
    vi.fn<
      (agentId?: string, overrides?: { security?: string; ask?: string }) => ExecApprovalsResolved
    >(),
}));

vi.mock("../infra/shell-env.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/shell-env.js")>();
  return {
    ...mod,
    getShellPathFromLoginShell: shellEnvMocks.getShellPathFromLoginShell,
    resolveShellEnvFallbackTimeoutMs: shellEnvMocks.resolveShellEnvFallbackTimeoutMs,
  };
});

vi.mock("../infra/exec-approvals.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/exec-approvals.js")>();
  return { ...mod, resolveExecApprovals: execApprovalsMocks.resolveExecApprovals };
});

let createExecTool: typeof import("./bash-tools.exec.js").createExecTool;

function createExecApprovals(): ExecApprovalsResolved {
  return {
    path: "/tmp/exec-approvals.json",
    socketPath: "/tmp/exec-approvals.sock",
    token: "token",
    defaults: {
      security: "full",
      ask: "off",
      askFallback: "full",
      autoAllowSkills: false,
    },
    agent: {
      security: "full",
      ask: "off",
      askFallback: "full",
      autoAllowSkills: false,
    },
    agentSources: {
      security: "defaults.security",
      ask: "defaults.ask",
      askFallback: "defaults.askFallback",
    },
    allowlist: [],
    file: {
      version: 1,
      socket: { path: "/tmp/exec-approvals.sock", token: "token" },
      defaults: {
        security: "full",
        ask: "off",
        askFallback: "full",
        autoAllowSkills: false,
      },
      agents: {},
    },
  };
}

async function loadFreshBashExecPathModulesForTest() {
  vi.resetModules();
  vi.doMock("../infra/shell-env.js", async (importOriginal) => {
    const mod = await importOriginal<typeof import("../infra/shell-env.js")>();
    return {
      ...mod,
      getShellPathFromLoginShell: shellEnvMocks.getShellPathFromLoginShell,
      resolveShellEnvFallbackTimeoutMs: shellEnvMocks.resolveShellEnvFallbackTimeoutMs,
    };
  });
  vi.doMock("../infra/exec-approvals.js", async (importOriginal) => {
    const mod = await importOriginal<typeof import("../infra/exec-approvals.js")>();
    return { ...mod, resolveExecApprovals: execApprovalsMocks.resolveExecApprovals };
  });
  const bashExec = await import("./bash-tools.exec.js");
  return {
    createExecTool: bashExec.createExecTool,
  };
}
const normalizeText = (value?: string) =>
  sanitizeBinaryOutput(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

const normalizePathEntries = (value?: string) =>
  normalizeText(value)
    .split(/[:\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

function createRecordingSandbox(recordCommand: (command: string) => void) {
  return createRecordingSandboxWithPaths(recordCommand, {
    workspaceDir: process.cwd(),
    containerWorkdir: process.cwd(),
  });
}

function createRecordingSandboxWithPaths(
  recordCommand: (command: string) => void,
  paths: { workspaceDir: string; containerWorkdir: string },
) {
  return {
    containerName: "sandbox-test",
    workspaceDir: paths.workspaceDir,
    containerWorkdir: paths.containerWorkdir,
    async buildExecSpec(params: {
      command: string;
      workdir?: string;
      env: Record<string, string>;
      usePty: boolean;
    }) {
      recordCommand(params.command);
      return {
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write(process.argv[1] ?? '')",
          params.command,
        ],
        env: process.env,
        stdinMode: "pipe-closed" as const,
      };
    },
  };
}

describe("exec PATH login shell merge", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeAll(async () => {
    ({ createExecTool } = await import("./bash-tools.exec.js"));
  });

  beforeEach(() => {
    envSnapshot = captureEnv(["PATH", "SHELL"]);
    execApprovalsMocks.resolveExecApprovals.mockReset();
    execApprovalsMocks.resolveExecApprovals.mockImplementation(() => createExecApprovals());
    shellEnvMocks.getShellPathFromLoginShell.mockReset();
    shellEnvMocks.getShellPathFromLoginShell.mockReturnValue("/custom/bin:/opt/bin");
    shellEnvMocks.resolveShellEnvFallbackTimeoutMs.mockReset();
    shellEnvMocks.resolveShellEnvFallbackTimeoutMs.mockReturnValue(1234);
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("merges login-shell PATH for host=gateway", async () => {
    if (isWin) {
      return;
    }
    process.env.PATH = "/usr/bin";

    const shellPathMock = shellEnvMocks.getShellPathFromLoginShell;
    shellPathMock.mockClear();
    shellPathMock.mockReturnValue("/custom/bin:/opt/bin");

    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
    const result = await tool.execute("call1", { command: "echo $PATH" });
    const entries = normalizePathEntries(result.content.find((c) => c.type === "text")?.text);

    expect(entries).toEqual(["/custom/bin", "/opt/bin", "/usr/bin"]);
    expect(shellPathMock).toHaveBeenCalledTimes(1);
  });

  it("sets OPENCLAW_SHELL for host=gateway commands", async () => {
    if (isWin) {
      return;
    }

    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
    const result = await tool.execute("call-openclaw-shell", {
      command: 'printf "%s" "${OPENCLAW_SHELL:-}"',
    });
    const value = normalizeText(result.content.find((c) => c.type === "text")?.text);

    expect(value).toBe("exec");
  });

  it("throws security violation when env.PATH is provided", async () => {
    if (isWin) {
      return;
    }
    process.env.PATH = "/usr/bin";

    const shellPathMock = shellEnvMocks.getShellPathFromLoginShell;
    shellPathMock.mockClear();

    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    await expect(
      tool.execute("call1", {
        command: "echo $PATH",
        env: { PATH: "/explicit/bin" },
      }),
    ).rejects.toThrow(/Security Violation: Custom 'PATH' variable is forbidden/);

    expect(shellPathMock).not.toHaveBeenCalled();
  });

  it("fails closed when a blocked runtime override key is requested", async () => {
    if (isWin) {
      return;
    }
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    await expect(
      tool.execute("call-blocked-runtime-env", {
        command: "echo ok",
        env: { CLASSPATH: "/tmp/evil-classpath" },
      }),
    ).rejects.toThrow(
      /Security Violation: Environment variable 'CLASSPATH' is forbidden during host execution\./,
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

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
      const result = await tool.execute("call1", { command: "echo $PATH" });
      const entries = normalizePathEntries(result.content.find((c) => c.type === "text")?.text);

      expect(entries).toEqual(["/usr/bin"]);
      expect(shellPathMock).toHaveBeenCalledTimes(1);
      expect(shellPathMock).toHaveBeenCalledWith(
        expect.objectContaining({
          env: process.env,
          timeoutMs: 1234,
        }),
      );
    } finally {
      fs.rmSync(shellDir, { recursive: true, force: true });
    }
  });
});

describe("exec host env validation", () => {
  beforeEach(async () => {
    execApprovalsMocks.resolveExecApprovals.mockReset();
    execApprovalsMocks.resolveExecApprovals.mockImplementation(() => createExecApprovals());
    ({ createExecTool } = await loadFreshBashExecPathModulesForTest());
  });

  it("blocks LD_/DYLD_ env vars on host execution", async () => {
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    await expect(
      tool.execute("call1", {
        command: "echo ok",
        env: { LD_DEBUG: "1" },
      }),
    ).rejects.toThrow(/Security Violation: Environment variable 'LD_DEBUG' is forbidden/);
  });

  it("blocks proxy and TLS override env vars on host execution", async () => {
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    await expect(
      tool.execute("call1", {
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
    const original = process.env.SSLKEYLOGFILE;
    process.env.SSLKEYLOGFILE = "/tmp/openclaw-ssl-keys.log";
    try {
      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
      const result = await tool.execute("call1", {
        command: "printf '%s' \"${SSLKEYLOGFILE:-}\"",
      });
      const output = normalizeText(result.content.find((c) => c.type === "text")?.text);
      expect(output).not.toContain("/tmp/openclaw-ssl-keys.log");
    } finally {
      if (original === undefined) {
        delete process.env.SSLKEYLOGFILE;
      } else {
        process.env.SSLKEYLOGFILE = original;
      }
    }
  });

  it("routes implicit auto host to gateway when sandbox runtime is unavailable", async () => {
    const tool = createExecTool({ security: "full", ask: "off" });

    const result = await tool.execute("call1", {
      command: "echo ok",
    });
    expect(normalizeText(result.content.find((c) => c.type === "text")?.text)).toBe("ok");
  });

  it("fails closed when sandbox host is explicitly configured without sandbox runtime", async () => {
    const tool = createExecTool({ host: "sandbox", security: "full", ask: "off" });

    await expect(
      tool.execute("call1", {
        command: "echo ok",
      }),
    ).rejects.toThrow(/requires a sandbox runtime/);
  });

  it("enforces explicit deny for sandbox exec", async () => {
    const tool = createExecTool({
      host: "sandbox",
      security: "deny",
      sandbox: createRecordingSandbox(() => undefined),
    });

    await expect(
      tool.execute("call-sandbox-deny-default", {
        command: "echo ok",
      }),
    ).rejects.toThrow("exec denied: host=sandbox security=deny");
  });

  it("rejects sandbox exec allowlist misses", async () => {
    const tool = createExecTool({
      host: "sandbox",
      security: "allowlist",
      ask: "off",
      sandbox: createRecordingSandbox(() => undefined),
    });

    await expect(
      tool.execute("call-sandbox-allowlist-miss", {
        command: "echo ok",
      }),
    ).rejects.toThrow("exec denied: allowlist miss");
  });

  it("allows sandbox allowlist absolute Linux paths without host fs probing", async () => {
    const runtimePath = "/__openclaw_virtual__/bin/python3";
    execApprovalsMocks.resolveExecApprovals.mockImplementation(() => ({
      ...createExecApprovals(),
      allowlist: [{ pattern: runtimePath }],
    }));

    let executedCommand = "";
    const tool = createExecTool({
      host: "sandbox",
      security: "allowlist",
      ask: "off",
      sandbox: createRecordingSandbox((command) => {
        executedCommand = command;
      }),
    });

    const result = await tool.execute("call-sandbox-virtual-resolution", {
      command: `${runtimePath} --version`,
    });

    expect(normalizeText(result.content.find((c) => c.type === "text")?.text)).toBe(
      executedCommand,
    );
    expect(executedCommand).toContain(runtimePath);
    expect(executedCommand).toContain("'--version'");
  });

  it("evaluates sandbox allowlist relative commands against container workdir", async () => {
    const hostWorkspace = process.cwd();
    const containerWorkspace = "/workspace";
    const runtimeToolPath = `${containerWorkspace}/tool`;
    execApprovalsMocks.resolveExecApprovals.mockImplementation(() => ({
      ...createExecApprovals(),
      allowlist: [{ pattern: runtimeToolPath }],
    }));

    let executedCommand = "";
    const tool = createExecTool({
      host: "sandbox",
      security: "allowlist",
      ask: "off",
      sandbox: createRecordingSandboxWithPaths(
        (command) => {
          executedCommand = command;
        },
        {
          workspaceDir: hostWorkspace,
          containerWorkdir: containerWorkspace,
        },
      ),
    });

    const result = await tool.execute("call-sandbox-relative-container-cwd", {
      command: "./tool --version",
      workdir: hostWorkspace,
    });

    expect(normalizeText(result.content.find((c) => c.type === "text")?.text)).toBe(
      executedCommand,
    );
    expect(executedCommand).toContain(runtimeToolPath);
    expect(executedCommand).toContain("'--version'");
  });

  it("quotes sandbox allowlist-approved command arguments before execution", async () => {
    const execPathReal =
      fs.realpathSync.native?.(process.execPath) ?? fs.realpathSync(process.execPath);
    execApprovalsMocks.resolveExecApprovals.mockImplementation(() => ({
      ...createExecApprovals(),
      allowlist: [{ pattern: process.execPath }, { pattern: execPathReal }],
    }));

    let executedCommand = "";
    const tool = createExecTool({
      host: "sandbox",
      security: "allowlist",
      ask: "off",
      sandbox: createRecordingSandbox((command) => {
        executedCommand = command;
      }),
    });

    const result = await tool.execute("call-sandbox-enforced-command", {
      command: `${JSON.stringify(process.execPath)} $HOME`,
    });

    expect(normalizeText(result.content.find((c) => c.type === "text")?.text)).toBe(
      executedCommand,
    );
    expect(executedCommand).toContain("'$HOME'");
    expect(executedCommand).not.toContain(" $HOME");

    const dockerArgs = buildDockerExecArgs({
      containerName: "sandbox-test",
      command: executedCommand,
      env: { HOME: "/home/user" },
      tty: false,
    });
    const bootstrapArg = dockerArgs[dockerArgs.length - 3];
    const dockerCommandArg = dockerArgs[dockerArgs.length - 1];
    expect(bootstrapArg).toBe('exec /bin/sh -c "$1"');
    expect(dockerCommandArg).toBe(executedCommand);
  });

  it.each([
    "echo ok && /approve abc123 allow-once",
    "echo ok | /approve abc123 deny",
    "echo ok\n/approve abc123 allow-once",
    "FOO=1 /approve abc123 allow-once",
    "env -i /approve abc123 deny",
    "env --ignore-environment /approve abc123 allow-once",
    "env -i FOO=1 /approve abc123 allow-once",
    "env -S '/approve abc123 deny'",
    "command /approve abc123 deny",
    "command -p /approve abc123 deny",
    "exec -a openclaw /approve abc123 deny",
    "sudo /approve abc123 allow-once",
    "sudo -E /approve abc123 allow-once",
    "bash -lc '/approve abc123 deny'",
    "bash -c 'sudo /approve abc123 allow-once'",
    "sh -c '/approve abc123 allow-once'",
  ])("rejects /approve shell commands in %s", async (command) => {
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    await expect(
      tool.execute("call-approve", {
        command,
      }),
    ).rejects.toThrow(/exec cannot run \/approve commands/);
  });
});
