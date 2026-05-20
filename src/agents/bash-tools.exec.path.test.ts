import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeConfigPaths } from "../config/normalize-paths.js";
import type { ExecApprovalsResolved } from "../infra/exec-approvals.js";
import { captureEnv } from "../test-utils/env.js";
import { sanitizeBinaryOutput } from "./shell-utils.js";

const isWin = process.platform === "win32";
const FOREGROUND_TEST_YIELD_MS = 120_000;
type GetShellPathFromLoginShell = typeof import("../infra/shell-env.js").getShellPathFromLoginShell;
const shellEnvMocks = vi.hoisted(() => ({
  getShellPathFromLoginShell: vi.fn<GetShellPathFromLoginShell>(() => "/custom/bin:/opt/bin"),
  resolveShellEnvFallbackTimeoutMs: vi.fn(() => 1234),
}));
const nodeMocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
  listNodes: vi.fn(),
  resolveNodeIdFromList: vi.fn(() => "node-1"),
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
  return { ...mod, resolveExecApprovals: () => createExecApprovals() };
});

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: nodeMocks.callGatewayTool,
}));

vi.mock("./tools/nodes-utils.js", () => ({
  listNodes: nodeMocks.listNodes,
  resolveNodeIdFromList: nodeMocks.resolveNodeIdFromList,
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: async (input: {
      argv?: string[];
      env?: NodeJS.ProcessEnv;
      onStdout?: (chunk: string) => void;
    }) => {
      const command = input.argv?.at(-1) ?? "";
      const env = input.env ?? {};
      if (command.includes("OPENCLAW_SHELL")) {
        input.onStdout?.(env.OPENCLAW_SHELL ?? "");
      } else if (command.includes("SSLKEYLOGFILE")) {
        input.onStdout?.(env.SSLKEYLOGFILE ?? "");
      } else if (command.includes("$PATH")) {
        input.onStdout?.(env.PATH ?? "");
      } else if (command === "echo ok") {
        input.onStdout?.("ok\n");
      }
      return {
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
    reconcileOrphans: vi.fn(),
    getRecord: vi.fn(),
  }),
}));

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

const normalizeText = (value?: string) =>
  sanitizeBinaryOutput(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

function normalizePathEntries(value?: string): string[] {
  const entries: string[] = [];
  for (const entry of normalizeText(value).split(/[:\s]+/)) {
    const normalized = entry.trim();
    if (normalized.length > 0) {
      entries.push(normalized);
    }
  }
  return entries;
}

describe("exec PATH login shell merge", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeAll(async () => {
    ({ createExecTool } = await import("./bash-tools.exec.js"));
  });

  beforeEach(() => {
    envSnapshot = captureEnv(["PATH", "SHELL"]);
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
    const result = await tool.execute("call1", {
      command: "echo $PATH",
      yieldMs: FOREGROUND_TEST_YIELD_MS,
    });
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
      yieldMs: FOREGROUND_TEST_YIELD_MS,
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
      const result = await tool.execute("call1", {
        command: "echo $PATH",
        yieldMs: FOREGROUND_TEST_YIELD_MS,
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
  it("blocks commands that target configured denied paths before host execution", async () => {
    const deniedRoot = path.join(os.tmpdir(), "openclaw-denied-secrets");
    const deniedFile = path.join(deniedRoot, "provider.key");
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      deniedPaths: [path.join(deniedRoot, "**")],
    });

    await expect(
      tool.execute("call-denied-path", {
        command: `cat "${deniedFile}"`,
      }),
    ).rejects.toThrow(`Security Violation: exec command references denied path ${deniedFile}`);
  });

  it("blocks denied paths inside shell wrapper payloads before host execution", async () => {
    const deniedRoot = path.join(os.tmpdir(), "openclaw-denied-shell-secrets");
    const deniedFile = path.join(deniedRoot, "provider.key");
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      deniedPaths: [path.join(deniedRoot, "**")],
    });

    await expect(
      tool.execute("call-denied-shell-path", {
        command: `bash -lc 'cat "${deniedFile}"'`,
      }),
    ).rejects.toThrow(`Security Violation: exec command references denied path ${deniedFile}`);
  });

  it("blocks denied paths inside shell command substitutions before host execution", async () => {
    const deniedRoot = path.join(os.tmpdir(), "openclaw-denied-substitution-secrets");
    const deniedFile = path.join(deniedRoot, "provider.key");
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      deniedPaths: [path.join(deniedRoot, "**")],
    });

    await expect(
      tool.execute("call-denied-substitution-path", {
        command: `bash -lc 'echo "$(cat "${deniedFile}")"'`,
      }),
    ).rejects.toThrow(`Security Violation: exec command references denied path ${deniedFile}`);
  });

  it("blocks sandbox relative denied paths in the container namespace before execution", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sandbox-denied-"));
    const workspaceDir = path.join(tempRoot, "host", "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    const buildExecSpec = vi.fn(async (params) => ({
      argv: ["sh", "-c", "echo should-not-run"],
      env: params.env,
      stdinMode: "pipe-closed" as const,
    }));
    const tool = createExecTool({
      host: "sandbox",
      security: "full",
      ask: "off",
      deniedPaths: ["/run/secrets/**"],
      sandbox: {
        containerName: "openclaw-test-sandbox",
        workspaceDir,
        containerWorkdir: "/workspace",
        buildExecSpec,
      },
    });

    try {
      await expect(
        tool.execute("call-denied-sandbox-path", {
          command: "cat ../../run/secrets/provider.key",
          workdir: "/workspace",
        }),
      ).rejects.toThrow(
        "Security Violation: exec command references denied path /run/secrets/provider.key",
      );
      expect(buildExecSpec).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps config-loaded home-relative denied paths in the sandbox HOME namespace", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sandbox-home-denied-"));
    const workspaceDir = path.join(tempRoot, "host", "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    const config = normalizeConfigPaths({
      tools: {
        exec: {
          deniedPaths: ["~/.openclaw/credentials/**"],
        },
      },
    });
    const buildExecSpec = vi.fn(async (params) => ({
      argv: ["sh", "-c", "echo should-not-run"],
      env: params.env,
      stdinMode: "pipe-closed" as const,
    }));
    const tool = createExecTool({
      host: "sandbox",
      security: "full",
      ask: "off",
      deniedPaths: config.tools?.exec?.deniedPaths,
      sandbox: {
        containerName: "openclaw-test-sandbox",
        workspaceDir,
        containerWorkdir: "/workspace",
        buildExecSpec,
      },
    });

    try {
      await expect(
        tool.execute("call-denied-sandbox-home-path", {
          command: 'cat "$HOME/.openclaw/credentials/provider.key"',
          workdir: "/workspace",
        }),
      ).rejects.toThrow(
        "Security Violation: exec command references denied path /workspace/.openclaw/credentials/provider.key",
      );
      expect(buildExecSpec).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("blocks sandbox home denied paths when request env overrides HOME", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sandbox-home-override-"));
    const workspaceDir = path.join(tempRoot, "host", "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    const config = normalizeConfigPaths({
      tools: {
        exec: {
          deniedPaths: ["~/.openclaw/credentials/**"],
        },
      },
    });
    const buildExecSpec = vi.fn(async (params) => ({
      argv: ["sh", "-c", "echo should-not-run"],
      env: params.env,
      stdinMode: "pipe-closed" as const,
    }));
    const tool = createExecTool({
      host: "sandbox",
      security: "full",
      ask: "off",
      deniedPaths: config.tools?.exec?.deniedPaths,
      sandbox: {
        containerName: "openclaw-test-sandbox",
        workspaceDir,
        containerWorkdir: "/workspace",
        buildExecSpec,
      },
    });

    try {
      await expect(
        tool.execute("call-denied-sandbox-home-override", {
          command: 'cat "$HOME/.openclaw/credentials/provider.key"',
          env: { HOME: "/tmp" },
          workdir: "/workspace",
        }),
      ).rejects.toThrow(
        "Security Violation: exec command references denied path /tmp/.openclaw/credentials/provider.key",
      );
      expect(buildExecSpec).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects host=node home-relative denied paths without a trusted node HOME", async () => {
    const config = normalizeConfigPaths({
      tools: {
        exec: {
          deniedPaths: ["~/.openclaw/credentials/**"],
        },
      },
    });
    nodeMocks.listNodes.mockReset();
    nodeMocks.listNodes.mockResolvedValueOnce([
      {
        nodeId: "node-1",
        commands: ["system.run"],
        platform: "win32",
      },
    ]);
    nodeMocks.resolveNodeIdFromList.mockClear();
    nodeMocks.callGatewayTool.mockReset();
    nodeMocks.callGatewayTool.mockResolvedValue({
      payload: {
        success: true,
        stdout: "should-not-run",
        stderr: "",
        exitCode: 0,
      },
    });
    const tool = createExecTool({
      host: "node",
      security: "full",
      ask: "off",
      deniedPaths: config.tools?.exec?.deniedPaths,
    });

    await expect(
      tool.execute("call-denied-node-home-path", {
        command: "type C:\\Users\\agent\\.openclaw\\credentials\\provider.key",
        workdir: "C:\\Work",
      }),
    ).rejects.toThrow(
      "Security Violation: exec host=node denied path pattern ~/.openclaw/credentials requires a trusted node HOME to resolve.",
    );
    expect(nodeMocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("blocks home-relative denied path patterns against the resolved home directory", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-denied-home-"));
    const originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    const deniedFile = path.join(homeDir, ".openclaw", "credentials", "provider.key");
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      deniedPaths: ["~/.openclaw/credentials/**"],
    });

    try {
      await expect(
        tool.execute("call-denied-home-path", {
          command: `cat "${deniedFile}"`,
        }),
      ).rejects.toThrow(`Security Violation: exec command references denied path ${deniedFile}`);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("blocks HOME-prefixed command paths against home-relative denied path patterns", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-denied-env-home-"));
    const originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    const deniedFile = path.join(homeDir, ".openclaw", "credentials", "provider.key");
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      deniedPaths: ["~/.openclaw/credentials/**"],
    });

    try {
      await expect(
        tool.execute("call-denied-env-home-path", {
          command: 'cat "$HOME/.openclaw/credentials/provider.key"',
        }),
      ).rejects.toThrow(`Security Violation: exec command references denied path ${deniedFile}`);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("blocks braced HOME-prefixed command paths inside shell wrapper payloads", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-denied-braced-home-"));
    const originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    const deniedFile = path.join(homeDir, ".openclaw", "credentials", "provider.key");
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      deniedPaths: ["~/.openclaw/credentials/**"],
    });

    try {
      await expect(
        tool.execute("call-denied-braced-home-path", {
          command: `bash -lc 'cat "\${HOME}/.openclaw/credentials/provider.key"'`,
        }),
      ).rejects.toThrow(`Security Violation: exec command references denied path ${deniedFile}`);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
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
        yieldMs: FOREGROUND_TEST_YIELD_MS,
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
      yieldMs: FOREGROUND_TEST_YIELD_MS,
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

  it.each([
    "echo ok && /approve abc123 allow-once",
    "echo ok | /approve abc123 deny",
    "echo ok\n/approve abc123 allow-once",
    "FOO=1 /approve abc123 allow-once",
    "env -i /approve abc123 deny",
    "env --ignore-environment /approve abc123 allow-once",
    "env -i FOO=1 /approve abc123 allow-once",
    "env -S '/approve abc123 deny'",
    "env -P /usr/bin /approve abc123 deny",
    "env -iS'/approve abc123 deny'",
    "env -S '/approve abc123' deny",
    "env -iS'/approve abc123' deny",
    "command /approve abc123 deny",
    "command -p /approve abc123 deny",
    "exec -a openclaw /approve abc123 deny",
    "sudo /approve abc123 allow-once",
    "sudo -E /approve abc123 allow-once",
    "sudo -EH /approve abc123 allow-once",
    "sudo -k /approve abc123 allow-once",
    "sudo --reset-timestamp /approve abc123 allow-once",
    "sudo --command-timeout=1 /approve abc123 allow-once",
    "sudo OPENCLAW_APPROVE=1 /approve abc123 allow-once",
    "sudo -uroot bash -lc '/approve abc123 allow-once'",
    "sudo -u root OPENCLAW_APPROVE=1 bash -lc '/approve abc123 allow-once'",
    "sudo -EH bash -lc '/approve abc123 allow-once'",
    "doas -uroot bash -lc '/approve abc123 deny'",
    "env env env env env env /approve abc123 allow-once",
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
