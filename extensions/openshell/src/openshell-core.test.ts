// Openshell tests cover openshell core plugin behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { disposeSshSandboxSession, shellEscape } from "openclaw/plugin-sdk/sandbox";
import type { TempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenShellSandboxBackend } from "./backend.types.js";
import { createOpenShellSshSession, runOpenShellCli } from "./cli.js";
import { resolveOpenShellPluginConfig } from "./config.js";
import {
  createMirrorBackendMock,
  createMirrorFsBridgeFixture,
  createOpenShellTestWorkspace,
  expectPathMissing,
} from "./openshell-fs.test-support.js";
import {
  createOpenShellBackendSandboxConfig,
  createOpenShellRuntimeEntryFixture,
} from "./openshell.test-support.js";

const cliMocks = vi.hoisted(() => ({
  runOpenShellCli: vi.fn(),
  createOpenShellSshSession: vi.fn(),
}));

const sandboxMocks = vi.hoisted(() => ({
  runSshSandboxCommand: vi.fn(),
  disposeSshSandboxSession: vi.fn(),
  prepareSshSandboxExec: vi.fn(),
  cleanupPreparedExec: vi.fn(),
  remoteRoot: "",
  remoteAgentRoot: "",
}));

let createOpenShellSandboxBackendManager: typeof import("./backend.js").createOpenShellSandboxBackendManager;
let createOpenShellSandboxBackendFactory: typeof import("./backend.js").createOpenShellSandboxBackendFactory;

async function installOpenShellBackendMocks() {
  vi.doMock("openclaw/plugin-sdk/sandbox", async () => {
    const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/sandbox")>(
      "openclaw/plugin-sdk/sandbox",
    );
    return {
      ...actual,
      disposeSshSandboxSession: sandboxMocks.disposeSshSandboxSession,
      prepareSshSandboxExec: sandboxMocks.prepareSshSandboxExec,
      runSshSandboxCommand: sandboxMocks.runSshSandboxCommand,
    };
  });
  vi.doMock("./cli.js", async () => {
    const actual = await vi.importActual<typeof import("./cli.js")>("./cli.js");
    return {
      ...actual,
      createOpenShellSshSession: cliMocks.createOpenShellSshSession,
      runOpenShellCli: cliMocks.runOpenShellCli,
    };
  });
  ({ createOpenShellSandboxBackendFactory, createOpenShellSandboxBackendManager } =
    await import("./backend.js"));
}

function uninstallOpenShellBackendMocks() {
  vi.doUnmock("openclaw/plugin-sdk/sandbox");
  vi.doUnmock("./cli.js");
  vi.resetModules();
}

function resetOpenShellBackendMocks() {
  vi.clearAllMocks();
  cliMocks.createOpenShellSshSession.mockResolvedValue({
    command: "ssh",
    configPath: "/tmp/openclaw-openshell-test-ssh-config",
    host: "openshell-test",
  });
  sandboxMocks.cleanupPreparedExec.mockResolvedValue(undefined);
  sandboxMocks.prepareSshSandboxExec.mockImplementation(
    async (params: {
      session: { command: string; configPath: string; host: string };
      tty?: boolean;
    }) => ({
      argv: [
        params.session.command,
        "-F",
        params.session.configPath,
        ...(params.tty ? ["-tt", "-o", "RequestTTY=force"] : ["-T", "-o", "RequestTTY=no"]),
        params.session.host,
        "'/bin/sh' '/tmp/openclaw-synthetic-staging/run.sh'",
      ],
      cleanup: sandboxMocks.cleanupPreparedExec,
    }),
  );
  sandboxMocks.runSshSandboxCommand.mockImplementation(
    async (params: { remoteCommand: string; stdin?: Buffer | string; allowFailure?: boolean }) => {
      const remoteCommand = params.remoteCommand
        .replaceAll("'/sandbox", `'${sandboxMocks.remoteRoot}`)
        .replaceAll("'/agent", `'${sandboxMocks.remoteAgentRoot}`);
      const result = spawnSync("sh", ["-c", remoteCommand], {
        input: params.stdin,
      });
      if (result.error) {
        throw result.error;
      }
      const stdout = Buffer.isBuffer(result.stdout)
        ? result.stdout
        : Buffer.from(result.stdout ?? "");
      const stderr = Buffer.isBuffer(result.stderr)
        ? result.stderr
        : Buffer.from(result.stderr ?? "");
      const code = result.status ?? 1;
      if (code !== 0 && !params.allowFailure) {
        throw Object.assign(new Error(stderr.toString("utf8").trim()), {
          code,
          stdout,
          stderr,
        });
      }
      return { stdout, stderr, code };
    },
  );
}

describe("openshell cli helpers", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it("passes direct gateway endpoints to openshell commands without registration", async () => {
    const calls: string[][] = [];
    const openshellCommand = await makeExecutable({
      name: "openshell",
      script: ["#!/bin/sh", `printf '%s\\n' "$*" >> "__LOG__"`, "exit 0"].join("\n"),
    });

    await runOpenShellCli({
      context: {
        sandboxName: "demo",
        config: resolveOpenShellPluginConfig({
          command: openshellCommand,
          gateway: "alice",
          gatewayEndpoint: "http://openshell.openshell-alice.svc.cluster.local:8080",
          workspace: "research",
        }),
      },
      args: ["sandbox", "get", "demo"],
    });

    const log = await fs.readFile(process.env.OPEN_SHELL_CLI_TEST_LOG as string, "utf8");
    for (const line of log.trim().split("\n")) {
      calls.push(line.split(" "));
    }
    expect(calls[0]).toEqual([
      "--gateway",
      "alice",
      "--gateway-endpoint",
      "http://openshell.openshell-alice.svc.cluster.local:8080",
      "--workspace",
      "research",
      "sandbox",
      "get",
      "demo",
    ]);
  });

  it("preserves the ambient workspace when workspace is not configured", async () => {
    process.env.OPENSHELL_WORKSPACE = "ambient";
    const openshellCommand = await makeExecutable({
      name: "openshell",
      script: ["#!/bin/sh", `printf '%s\\n' "$OPENSHELL_WORKSPACE|$*" >> "__LOG__"`, "exit 0"].join(
        "\n",
      ),
    });

    await runOpenShellCli({
      context: {
        sandboxName: "demo",
        config: resolveOpenShellPluginConfig({ command: openshellCommand }),
      },
      args: ["sandbox", "get", "demo"],
    });

    await expect(fs.readFile(process.env.OPEN_SHELL_CLI_TEST_LOG as string, "utf8")).resolves.toBe(
      "ambient|sandbox get demo\n",
    );
  });

  it.runIf(process.platform !== "win32")(
    "preserves workspace selection when adding a direct gateway endpoint",
    async () => {
      const configText = [
        "Host openshell-demo.research",
        "    User sandbox",
        "    ProxyCommand /usr/local/bin/openshell ssh-proxy --gateway-name alice --name demo --workspace research",
        "",
      ].join("\n");

      await expect(
        readOpenShellSshConfig({
          configText,
          gatewayEndpoint: "http://openshell.openshell-alice.svc.cluster.local:8080",
          workspace: "research",
        }),
      ).resolves.toContain(
        "ProxyCommand /usr/local/bin/openshell ssh-proxy --gateway-name alice --name demo --workspace research --server 'http://openshell.openshell-alice.svc.cluster.local:8080'",
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "leaves ssh proxy configs with an explicit endpoint unchanged",
    async () => {
      const configText =
        "Host openshell-demo\n    ProxyCommand openshell ssh-proxy --gateway-name alice --name demo --server 'http://existing'\n";

      await expect(
        readOpenShellSshConfig({
          configText,
          gatewayEndpoint: "http://replacement",
        }),
      ).resolves.toContain(
        "ProxyCommand openshell ssh-proxy --gateway-name alice --name demo --server 'http://existing'",
      );
    },
  );
});

describe("openshell backend manager", () => {
  beforeAll(installOpenShellBackendMocks);
  afterAll(uninstallOpenShellBackendMocks);
  beforeEach(resetOpenShellBackendMocks);

  it("builds deterministic OpenShell-compatible sandbox names", async () => {
    const factory = createOpenShellSandboxBackendFactory({
      pluginConfig: resolveOpenShellPluginConfig({ command: "openshell" }),
    });
    const createBackend = async (scopeKey: string, registeredRuntimeIds?: readonly string[]) =>
      await factory({
        sessionKey: `${scopeKey}:turn`,
        scopeKey,
        ...(registeredRuntimeIds ? { registeredRuntimeIds } : {}),
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/workspace",
        cfg: createOpenShellBackendSandboxConfig(),
      });

    const first = await createBackend("agent:main");
    const repeated = await createBackend("agent:main");
    const other = await createBackend("agent:other");
    const workspaceScoped = await createBackend(`agent:main:workspace:${"a".repeat(32)}`);
    const legacyRuntimeId = "openclaw-agent-main-25bffc4d";
    const adoptedLegacy = await createBackend("agent:main", [legacyRuntimeId]);
    const punctuationLegacyRuntimeId = "openclaw-agent-foo-bar-baz-ab401a99";
    const adoptedPunctuationLegacy = await createBackend("agent:foo_bar.baz", [
      punctuationLegacyRuntimeId,
    ]);
    const ignoresUnknown = await createBackend("agent:main", ["unrelated-runtime"]);
    const prefersCurrent = await createBackend("agent:main", [legacyRuntimeId, first.runtimeId]);

    expect(first.runtimeId).toMatch(/^oc-[a-f0-9]{16}$/u);
    expect(first.runtimeId).toHaveLength(19);
    expect(repeated.runtimeId).toBe(first.runtimeId);
    expect(other.runtimeId).not.toBe(first.runtimeId);
    expect(workspaceScoped.runtimeId).toMatch(/^oc-[a-z0-9]{16}$/u);
    expect(workspaceScoped.runtimeId).toHaveLength(19);
    expect(workspaceScoped.runtimeId).not.toBe(first.runtimeId);
    expect(adoptedLegacy.runtimeId).toBe(legacyRuntimeId);
    expect(adoptedPunctuationLegacy.runtimeId).toBe(punctuationLegacyRuntimeId);
    expect(ignoresUnknown.runtimeId).toBe(first.runtimeId);
    expect(prefersCurrent.runtimeId).toBe(first.runtimeId);
  });

  it("does not recreate an unreachable registered legacy sandbox name", async () => {
    const scopeKey = "agent:main'$(touch /tmp/pwn)";
    const legacyRuntimeId = "openclaw-agent-main-touch-tmp-pwn-87608e6a";
    cliMocks.runOpenShellCli.mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "sandbox not found",
    });
    const factory = createOpenShellSandboxBackendFactory({
      pluginConfig: resolveOpenShellPluginConfig({ command: "openshell", mode: "remote" }),
    });
    const backend = await factory({
      sessionKey: `${scopeKey}:turn`,
      scopeKey,
      registeredRuntimeIds: [legacyRuntimeId],
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: createOpenShellBackendSandboxConfig(),
    });

    await expect(
      backend.runShellCommand({
        script: "true",
      }),
    ).rejects.toThrow(
      `Run \`openclaw sandbox recreate --session ${shellEscape(scopeKey)}\` to migrate this scope`,
    );
    expect(cliMocks.runOpenShellCli).toHaveBeenCalledTimes(1);
    expect(cliMocks.runOpenShellCli).not.toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining(["create"]),
      }),
    );
  });

  it.each([
    ["gateway authentication expired", "gateway authentication expired"],
    ["", "openshell sandbox get failed"],
  ])(
    "does not create a sandbox after a failed control-plane lookup: %s",
    async (stderr, expected) => {
      cliMocks.runOpenShellCli.mockResolvedValue({ code: 1, stdout: "", stderr });
      const backend = await createOpenShellBackendFixture({
        workspaceDir: "/tmp/workspace",
        mode: "remote",
      });

      await expect(backend.runShellCommand({ script: "true" })).rejects.toThrow(expected);
      expect(cliMocks.runOpenShellCli).toHaveBeenCalledOnce();
    },
  );

  it("does not execute a registered legacy sandbox that is no longer ready", async () => {
    const scopeKey = "agent:main";
    const legacyRuntimeId = "openclaw-agent-main-25bffc4d";
    cliMocks.runOpenShellCli
      .mockResolvedValueOnce({
        code: 0,
        stdout: "sandbox detail",
        stderr: "",
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify(
          Array.from({ length: 100 }, (_, index) => ({
            name: `other-${index}`,
            phase: "Ready",
          })),
        ),
        stderr: "",
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify([{ name: legacyRuntimeId, phase: "Error" }]),
        stderr: "",
      });
    const factory = createOpenShellSandboxBackendFactory({
      pluginConfig: resolveOpenShellPluginConfig({ command: "openshell", mode: "remote" }),
    });
    const backend = await factory({
      sessionKey: `${scopeKey}:turn`,
      scopeKey,
      registeredRuntimeIds: [legacyRuntimeId],
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: createOpenShellBackendSandboxConfig(),
    });

    await expect(backend.runShellCommand({ script: "true" })).rejects.toThrow(
      'OpenShell reports phase "Error".',
    );
    expect(cliMocks.runOpenShellCli).toHaveBeenNthCalledWith(2, {
      context: expect.objectContaining({
        sandboxName: legacyRuntimeId,
      }),
      args: ["sandbox", "list", "--limit", "100", "--offset", "0", "--output", "json"],
      cwd: "/tmp/workspace",
    });
    expect(cliMocks.runOpenShellCli).toHaveBeenNthCalledWith(3, {
      context: expect.objectContaining({
        sandboxName: legacyRuntimeId,
      }),
      args: ["sandbox", "list", "--limit", "100", "--offset", "100", "--output", "json"],
      cwd: "/tmp/workspace",
    });
    expect(cliMocks.runOpenShellCli).not.toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining(["create"]),
      }),
    );
    expect(cliMocks.createOpenShellSshSession).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32")(
    "clears the materialized skills directory through the remote backend boundary",
    async () => {
      await using workspace = await createOpenShellTestWorkspace("workspace");
      const workspaceDir = workspace.dir;
      await using skillsWorkspace = await createOpenShellTestWorkspace("skills");
      const skillsWorkspaceDir = skillsWorkspace.dir;
      await using remoteWorkspace = await createOpenShellTestWorkspace("remote");
      sandboxMocks.remoteRoot = remoteWorkspace.dir;
      await using remoteAgentWorkspace = await createOpenShellTestWorkspace("agent-remote");
      sandboxMocks.remoteAgentRoot = remoteAgentWorkspace.dir;
      const materializedDir = path.join(sandboxMocks.remoteRoot, ".openclaw", "sandbox-skills");
      await fs.mkdir(materializedDir, { recursive: true });
      await fs.writeFile(path.join(materializedDir, "stale.txt"), "stale", "utf8");
      await fs.writeFile(path.join(skillsWorkspaceDir, "SKILL.md"), "# Skill\n", "utf8");
      cliMocks.runOpenShellCli.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

      const backend = await createOpenShellBackendFixture({
        workspaceDir,
        skillsWorkspaceDir,
        mode: "remote",
      });
      if (!backend.runRemoteShellScript) {
        throw new Error("Expected OpenShell remote script boundary");
      }

      const result = await backend.runRemoteShellScript({
        script: 'test -d "$1"',
        args: ["/sandbox/.openclaw/sandbox-skills"],
      });

      expect(result?.code).toBe(0);
      await expectPathMissing(path.join(materializedDir, "stale.txt"));
      await expect(fs.stat(materializedDir)).resolves.toBeDefined();
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects symlinked materialized skills parents through the remote backend boundary",
    async () => {
      await using workspace = await createOpenShellTestWorkspace("workspace");
      const workspaceDir = workspace.dir;
      await using skillsWorkspace = await createOpenShellTestWorkspace("skills");
      const skillsWorkspaceDir = skillsWorkspace.dir;
      await using remoteWorkspace = await createOpenShellTestWorkspace("remote");
      sandboxMocks.remoteRoot = remoteWorkspace.dir;
      await using remoteAgentWorkspace = await createOpenShellTestWorkspace("agent-remote");
      sandboxMocks.remoteAgentRoot = remoteAgentWorkspace.dir;
      await using outsideWorkspace = await createOpenShellTestWorkspace("outside");
      const outsideDir = outsideWorkspace.dir;
      await fs.symlink(outsideDir, path.join(sandboxMocks.remoteRoot, ".openclaw"));
      await fs.writeFile(path.join(skillsWorkspaceDir, "SKILL.md"), "# Skill\n", "utf8");
      cliMocks.runOpenShellCli.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

      const backend = await createOpenShellBackendFixture({
        workspaceDir,
        skillsWorkspaceDir,
        mode: "remote",
      });
      if (!backend.runRemoteShellScript) {
        throw new Error("Expected OpenShell remote script boundary");
      }

      await expect(backend.runRemoteShellScript({ script: "true" })).rejects.toThrow(
        "unsafe remote directory symlink",
      );
      await expect(fs.readdir(outsideDir)).resolves.toEqual([]);
    },
  );

  it("checks runtime status with config override from OpenClaw config", async () => {
    cliMocks.runOpenShellCli.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ phase: "Ready" }),
      stderr: "",
    });

    const manager = createOpenShellSandboxBackendManager({
      pluginConfig: resolveOpenShellPluginConfig({
        command: "openshell",
        from: "openclaw",
      }),
    });

    const result = await manager.describeRuntime({
      entry: createOpenShellRuntimeEntryFixture("openclaw-session-1234", "custom-source"),
      config: {
        plugins: {
          entries: {
            openshell: {
              enabled: true,
              config: {
                command: "openshell",
                from: "custom-source",
              },
            },
          },
        },
      },
    });

    expect(result).toEqual({
      running: true,
      actualConfigLabel: "custom-source",
      configLabelMatch: true,
    });
    const expectedConfig = resolveOpenShellPluginConfig({
      command: "openshell",
      from: "custom-source",
    });
    expect(cliMocks.runOpenShellCli).toHaveBeenCalledWith({
      context: {
        sandboxName: "openclaw-session-1234",
        config: expectedConfig,
      },
      args: ["sandbox", "get", "openclaw-session-1234", "--output", "json"],
    });
  });

  it("does not report a provisioning OpenShell runtime as running", async () => {
    cliMocks.runOpenShellCli.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ phase: "Provisioning" }),
      stderr: "",
    });
    const manager = createOpenShellSandboxBackendManager({
      pluginConfig: resolveOpenShellPluginConfig({ command: "openshell" }),
    });

    await expect(
      manager.describeRuntime({
        entry: createOpenShellRuntimeEntryFixture("openclaw-session-1234"),
        config: {},
      }),
    ).resolves.toMatchObject({ running: false });
  });

  it("removes runtimes using the current OpenShell control-plane configuration", async () => {
    cliMocks.runOpenShellCli.mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });

    const manager = createOpenShellSandboxBackendManager({
      pluginConfig: resolveOpenShellPluginConfig({
        command: "/usr/local/bin/openshell",
        gateway: "lab",
      }),
    });

    await manager.removeRuntime({
      entry: createOpenShellRuntimeEntryFixture("openclaw-session-5678"),
      config: {},
    });

    const expectedConfig = resolveOpenShellPluginConfig({
      command: "/usr/local/bin/openshell",
      gateway: "lab",
    });
    expect(cliMocks.runOpenShellCli).toHaveBeenCalledWith({
      context: {
        sandboxName: "openclaw-session-5678",
        config: expectedConfig,
      },
      args: ["sandbox", "delete", "openclaw-session-5678"],
    });

    await manager.removeRuntime({
      entry: createOpenShellRuntimeEntryFixture("openclaw-session-5678"),
      config: {
        plugins: {
          entries: {
            openshell: {
              enabled: true,
              config: {
                command: "/opt/openshell/bin/openshell",
                gateway: "research",
                workspace: "team-1",
              },
            },
          },
        },
      },
    });

    expect(cliMocks.runOpenShellCli).toHaveBeenLastCalledWith({
      context: {
        sandboxName: "openclaw-session-5678",
        config: resolveOpenShellPluginConfig({
          command: "/opt/openshell/bin/openshell",
          gateway: "research",
          workspace: "team-1",
        }),
      },
      args: ["sandbox", "delete", "openclaw-session-5678"],
    });
  });

  it.each([
    ["gateway unavailable", "gateway unavailable"],
    ["", "openshell sandbox delete failed"],
  ])("preserves deletion failures for sandbox lifecycle owners: %s", async (stderr, expected) => {
    cliMocks.runOpenShellCli.mockResolvedValue({
      code: 1,
      stdout: "",
      stderr,
    });

    const manager = createOpenShellSandboxBackendManager({
      pluginConfig: resolveOpenShellPluginConfig({ command: "openshell" }),
    });

    await expect(
      manager.removeRuntime({
        entry: createOpenShellRuntimeEntryFixture("openclaw-session-5678"),
        config: {},
      }),
    ).rejects.toThrow(expected);
  });

  it("rejects malformed exec commands before opening an OpenShell SSH session", async () => {
    const backend = await createOpenShellBackendFixture({
      workspaceDir: "/tmp/workspace",
      mode: "mirror",
    });

    await expect(
      backend.buildExecSpec({
        command: "workflow install <name>",
        env: {},
        usePty: false,
      }),
    ).rejects.toThrow(/unresolved placeholder token <name>/);
    expect(cliMocks.runOpenShellCli).not.toHaveBeenCalled();
  });

  it.each(["remote", "mirror"] as const)(
    "rejects invalid exec environment before SSH staging and releases the %s session",
    async (mode) => {
      await using workspace = await createOpenShellTestWorkspace("env-workspace");
      await using remote = await createOpenShellTestWorkspace("env-remote");
      await using agentRemote = await createOpenShellTestWorkspace("env-agent");
      sandboxMocks.remoteRoot = remote.dir;
      sandboxMocks.remoteAgentRoot = agentRemote.dir;
      cliMocks.runOpenShellCli.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
      const sshCommand = await makeExecutable({
        name: "ssh-refuse",
        script: ["#!/bin/sh", `printf 'unexpected launch\\n' >> "__LOG__"`, "exit 91"].join("\n"),
      });
      const logPath = expectDefined(process.env.OPEN_SHELL_CLI_TEST_LOG, "SSH launch record");
      await fs.writeFile(logPath, "not launched\n", "utf8");
      const session = {
        command: sshCommand,
        configPath: path.join(workspace.dir, "ssh-config"),
        host: "openshell-test",
      };
      cliMocks.createOpenShellSshSession.mockResolvedValue(session);
      const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/sandbox")>(
        "openclaw/plugin-sdk/sandbox",
      );
      let disposalCallsAtPrepare = 0;
      sandboxMocks.prepareSshSandboxExec.mockImplementationOnce(async (params) => {
        disposalCallsAtPrepare = sandboxMocks.disposeSshSandboxSession.mock.calls.length;
        return await actual.prepareSshSandboxExec(params);
      });
      const backend = await createOpenShellBackendFixture({
        workspaceDir: workspace.dir,
        mode,
      });
      const rejection = await backend
        .buildExecSpec({
          command: "true",
          env: { "INVALID-NAME": "fixture" },
          usePty: false,
        })
        .catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(Error);
      await expect(fs.readFile(logPath, "utf8")).resolves.toBe("not launched\n");
      expect(sandboxMocks.disposeSshSandboxSession).toHaveBeenCalledTimes(
        disposalCallsAtPrepare + 1,
      );
      expect(sandboxMocks.disposeSshSandboxSession).toHaveBeenLastCalledWith(session);

      const valid = await backend.buildExecSpec({
        command: "true",
        env: { VALID_NAME: "fixture" },
        usePty: false,
      });
      await backend.finalizeExec?.({
        status: "completed",
        exitCode: 0,
        timedOut: false,
        token: valid.finalizeToken,
      });
      expect(sandboxMocks.cleanupPreparedExec).toHaveBeenCalledOnce();
      await expect(fs.readFile(logPath, "utf8")).resolves.toBe("not launched\n");
      expect(String(rejection)).toContain("Invalid sandbox environment variable name");
    },
  );

  it("stages exec environment outside SSH argv and cleans completed execs before session disposal", async () => {
    const sentinel = "synthetic-openshell-env-value";
    cliMocks.runOpenShellCli.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    sandboxMocks.runSshSandboxCommand.mockResolvedValueOnce({
      stdout: Buffer.from("1\n"),
      stderr: Buffer.alloc(0),
      code: 0,
    });
    const backend = await createOpenShellBackendFixture({
      workspaceDir: "/tmp/openclaw-synthetic-workspace",
      mode: "remote",
    });

    const execSpec = await backend.buildExecSpec({
      command: "printenv SYNTHETIC_VALUE",
      workdir: "/sandbox",
      env: { SYNTHETIC_VALUE: sentinel },
      usePty: true,
    });

    expect(sandboxMocks.prepareSshSandboxExec).toHaveBeenCalledWith({
      session: expect.objectContaining({ host: "openshell-test" }),
      remoteCommand: expect.stringContaining("printenv SYNTHETIC_VALUE"),
      env: { SYNTHETIC_VALUE: sentinel },
      tty: true,
    });
    expect(execSpec.argv.join(" ")).not.toContain(sentinel);
    expect(execSpec.argv).toContain("-tt");
    expect(execSpec.argv.join(" ")).not.toContain("SetEnv");
    expect(execSpec.stdinMode).toBe("pipe-open");

    sandboxMocks.disposeSshSandboxSession.mockClear();
    await backend.finalizeExec?.({
      status: "completed",
      exitCode: 0,
      timedOut: false,
      token: execSpec.finalizeToken,
    });

    expect(sandboxMocks.cleanupPreparedExec).toHaveBeenCalledOnce();
    expect(sandboxMocks.disposeSshSandboxSession).toHaveBeenCalledWith(
      expect.objectContaining({ host: "openshell-test" }),
    );
    expect(sandboxMocks.cleanupPreparedExec.mock.invocationCallOrder[0]).toBeLessThan(
      expectDefined(
        sandboxMocks.disposeSshSandboxSession.mock.invocationCallOrder[0],
        "OpenShell SSH session disposal invocation",
      ),
    );
  });

  it("disposes the OpenShell SSH session when secure exec staging fails", async () => {
    cliMocks.runOpenShellCli.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    sandboxMocks.runSshSandboxCommand.mockResolvedValueOnce({
      stdout: Buffer.from("1\n"),
      stderr: Buffer.alloc(0),
      code: 0,
    });
    sandboxMocks.prepareSshSandboxExec.mockRejectedValueOnce(
      new Error("synthetic staging failure"),
    );
    const backend = await createOpenShellBackendFixture({
      workspaceDir: "/tmp/openclaw-synthetic-workspace",
      mode: "remote",
    });

    await expect(
      backend.buildExecSpec({
        command: "true",
        env: { SYNTHETIC_VALUE: "synthetic-openshell-env-value" },
        usePty: false,
      }),
    ).rejects.toThrow("synthetic staging failure");

    expect(sandboxMocks.disposeSshSandboxSession).toHaveBeenCalledTimes(2);
  });

  it.each([
    "success",
    "source cleanup failure",
    "retained source replacement",
    "restore cleanup failure",
  ] as const)(
    "preserves and reports a local shadow when cross-filesystem mirror sync ends with %s",
    async (outcome) => {
      await using workspace = await createOpenShellTestWorkspace("workspace");
      const workspaceDir = workspace.dir;
      const shadowFile = path.join(workspaceDir, ".openclaw", "sandbox-skills", "user-note.txt");
      await fs.mkdir(path.dirname(shadowFile), { recursive: true });
      await fs.writeFile(shadowFile, "local shadow", "utf8");
      const sourceContents = new Map([["user-note.txt", "local shadow"]]);
      if (outcome === "source cleanup failure" || outcome === "restore cleanup failure") {
        sourceContents.set("second-note.txt", "second shadow");
        await fs.writeFile(path.join(path.dirname(shadowFile), "second-note.txt"), "second shadow");
      }

      let preservedPath: string | undefined;
      let sourceCleanupFailed = false;
      const removedSourceFiles: string[] = [];
      let retainedSourceFile: string | undefined;
      let sourceAtCleanupFailure: string[] = [];
      const originalRename = fs.rename.bind(fs);
      const originalUnlink = fs.unlink.bind(fs);
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        const source = String(from);
        const target = String(to);
        const shadowDir = path.dirname(shadowFile);
        const isFallbackStagedMove = path.basename(source).startsWith(".fs-safe-move-");
        if (source === shadowDir || (target === shadowDir && !isFallbackStagedMove)) {
          throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
        }
        await originalRename(from, to);
        if (isFallbackStagedMove && path.basename(target) === "shadow") {
          // Observe a real completed destination publication before injecting a source race.
          preservedPath = target;
          if (outcome === "retained source replacement") {
            await originalUnlink(shadowFile);
            await fs.writeFile(shadowFile, "concurrent replacement", "utf8");
          }
        }
      });
      const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
        const cleanupRoot =
          outcome === "source cleanup failure"
            ? path.dirname(shadowFile)
            : outcome === "restore cleanup failure"
              ? preservedPath
              : undefined;
        const sourceCleanup =
          cleanupRoot !== undefined && path.dirname(String(target)) === cleanupRoot;
        if (sourceCleanup && removedSourceFiles.length === 1 && !sourceCleanupFailed) {
          retainedSourceFile = String(target);
          sourceAtCleanupFailure = await fs.readdir(
            expectDefined(cleanupRoot, "source cleanup root"),
          );
          sourceCleanupFailed = true;
          // The first source unlink completed; the second is refused before dispatch.
          throw Object.assign(new Error("source cleanup failed after publication"), {
            code: "EACCES",
          });
        }
        await originalUnlink(target);
        if (sourceCleanup) {
          removedSourceFiles.push(String(target));
        }
      });
      cliMocks.runOpenShellCli.mockImplementation(async ({ args }: { args: string[] }) => {
        if (args[0] === "sandbox" && args[1] === "download") {
          const tmpDir = expectDefined(args[4], "OpenShell download destination");
          await fs.writeFile(path.join(tmpDir, "from-remote.txt"), "remote", "utf8");
          await fs.mkdir(path.join(tmpDir, ".openclaw", "sandbox-skills", "skills"), {
            recursive: true,
          });
          await fs.writeFile(
            path.join(tmpDir, ".openclaw", "sandbox-skills", "skills", "generated.txt"),
            "generated",
            "utf8",
          );
        }
        return { code: 0, stdout: "", stderr: "" };
      });

      const backend = await createOpenShellBackendFixture({ workspaceDir, mode: "mirror" });

      try {
        let finalizeError: unknown;
        try {
          await finalizeMirror(backend);
        } catch (error) {
          finalizeError = error;
        }

        expect(renameSpy).toHaveBeenCalled();
        expect(preservedPath).toBeDefined();
        if (outcome === "success") {
          expect(finalizeError).toBeUndefined();
          await expect(fs.readFile(shadowFile, "utf8")).resolves.toBe("local shadow");
          await expect(
            fs.readFile(path.join(workspaceDir, "from-remote.txt"), "utf8"),
          ).resolves.toBe("remote");
        } else {
          expect(finalizeError).toMatchObject({
            cause: { code: outcome === "retained source replacement" ? "ESTALE" : "EACCES" },
          });
          const backup = expectDefined(preservedPath, "completed shadow publication");
          const completeCopy =
            outcome === "restore cleanup failure" ? path.dirname(shadowFile) : backup;
          for (const [name, contents] of sourceContents) {
            await expect(fs.readFile(path.join(completeCopy, name), "utf8")).resolves.toBe(
              contents,
            );
          }
          if (outcome === "restore cleanup failure") {
            await expect(
              fs.readFile(path.join(workspaceDir, "from-remote.txt"), "utf8"),
            ).resolves.toBe("remote");
          } else {
            await expectPathMissing(path.join(workspaceDir, "from-remote.txt"));
          }
          if (outcome === "source cleanup failure" || outcome === "restore cleanup failure") {
            expect(sourceCleanupFailed).toBe(true);
            expect(removedSourceFiles).toHaveLength(1);
            await expectPathMissing(expectDefined(removedSourceFiles[0], "removed source file"));
            const retained = expectDefined(retainedSourceFile, "refused source unlink");
            expect(sourceAtCleanupFailure).toEqual([path.basename(retained)]);
            await expect(fs.readFile(retained, "utf8")).resolves.toBe(
              sourceContents.get(path.basename(retained)),
            );
          } else {
            await expect(fs.readFile(shadowFile, "utf8")).resolves.toBe("concurrent replacement");
          }
          // The caller must be able to locate its retained original after a partial move.
          expect(
            String(finalizeError),
            JSON.stringify({
              outcome,
              sourceFiles: await fs.readdir(path.dirname(shadowFile)),
              backupFiles: await fs.readdir(backup),
              sourceAtCleanupFailure,
            }),
          ).toContain(backup);
        }
        await expectPathMissing(
          path.join(workspaceDir, ".openclaw", "sandbox-skills", "skills", "generated.txt"),
        );
      } finally {
        renameSpy.mockRestore();
        unlinkSpy.mockRestore();
        if (preservedPath) {
          await fs.rm(path.dirname(preservedPath), { recursive: true, force: true });
        }
      }
    },
  );

  it("drops non-directory materialized sandbox skills from mirror downloads", async () => {
    await using workspace = await createOpenShellTestWorkspace("workspace");
    const workspaceDir = workspace.dir;
    cliMocks.runOpenShellCli.mockImplementation(async ({ args }: { args: string[] }) => {
      if (args[0] === "sandbox" && args[1] === "download") {
        const tmpDir = expectDefined(args[4], "OpenShell download destination");
        await fs.writeFile(path.join(tmpDir, "from-remote.txt"), "remote", "utf8");
        await fs.mkdir(path.join(tmpDir, ".openclaw"), { recursive: true });
        await fs.writeFile(path.join(tmpDir, ".openclaw", "sandbox-skills"), "poison", "utf8");
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const backend = await createOpenShellBackendFixture({ workspaceDir, mode: "mirror" });

    await finalizeMirror(backend);

    await expect(fs.readFile(path.join(workspaceDir, "from-remote.txt"), "utf8")).resolves.toBe(
      "remote",
    );
    await expectPathMissing(path.join(workspaceDir, ".openclaw", "sandbox-skills"));
  });

  it.each(["original", "replaced"] as const)(
    "restores only the %s backup when mirror download has a file parent",
    async (backupState) => {
      await using workspace = await createOpenShellTestWorkspace("workspace");
      const workspaceDir = workspace.dir;
      const shadowFile = path.join(workspaceDir, ".openclaw", "sandbox-skills", "user-note.txt");
      const parentPath = path.join(workspaceDir, ".openclaw");
      await fs.mkdir(path.dirname(shadowFile), { recursive: true });
      await fs.writeFile(shadowFile, "local shadow", "utf8");
      cliMocks.runOpenShellCli.mockImplementation(async ({ args }: { args: string[] }) => {
        if (args[0] === "sandbox" && args[1] === "download") {
          const tmpDir = expectDefined(args[4], "OpenShell download destination");
          await fs.writeFile(path.join(tmpDir, "from-remote.txt"), "remote", "utf8");
          await fs.writeFile(path.join(tmpDir, ".openclaw"), "poison", "utf8");
        }
        return { code: 0, stdout: "", stderr: "" };
      });
      let preservedPath: string | undefined;
      let replaced = false;
      const rename = fs.rename;
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        await rename(from, to);
        if (path.basename(String(to)) === "shadow") {
          preservedPath = String(to);
        }
      });
      const lstat = fs.lstat;
      let parentConflictCreated = false;
      const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        let stat;
        try {
          stat = await lstat(...args);
        } catch (error) {
          if (
            !preservedPath ||
            parentConflictCreated ||
            String(args[0]) !== parentPath ||
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "ENOENT"
          ) {
            throw error;
          }
          // Mirror removed the empty ancestor; exercise restoration's file-parent contract.
          await fs.writeFile(parentPath, "poison", "utf8");
          parentConflictCreated = true;
          stat = await lstat(...args);
        }
        if (
          backupState === "replaced" &&
          !replaced &&
          preservedPath &&
          String(args[0]) === parentPath &&
          stat.isFile()
        ) {
          // Change backup ownership during the last awaited parent check before restoration.
          await rename(preservedPath, `${preservedPath}-original`);
          await fs.mkdir(preservedPath);
          await fs.writeFile(path.join(preservedPath, "replacement.txt"), "replacement backup");
          replaced = true;
        }
        return stat;
      });
      const backend = await createOpenShellBackendFixture({ workspaceDir, mode: "mirror" });
      try {
        const finalization = finalizeMirror(backend);
        if (backupState === "replaced") {
          await expect(finalization).rejects.toThrow("unverified workspace shadow");
          expect(replaced).toBe(true);
          const backup = expectDefined(preservedPath, "published original shadow");
          await expect(fs.readFile(parentPath, "utf8")).resolves.toBe("poison");
          await expect(fs.readFile(path.join(backup, "replacement.txt"), "utf8")).resolves.toBe(
            "replacement backup",
          );
          await expect(
            fs.readFile(path.join(`${backup}-original`, "user-note.txt"), "utf8"),
          ).resolves.toBe("local shadow");
        } else {
          await finalization;
          await expect(fs.readFile(shadowFile, "utf8")).resolves.toBe("local shadow");
          expect((await fs.stat(parentPath)).isDirectory()).toBe(true);
        }
        expect(parentConflictCreated).toBe(true);
        await expect(fs.readFile(path.join(workspaceDir, "from-remote.txt"), "utf8")).resolves.toBe(
          "remote",
        );
      } finally {
        renameSpy.mockRestore();
        lstatSpy.mockRestore();
        if (preservedPath) {
          await fs.rm(path.dirname(preservedPath), { recursive: true, force: true });
        }
      }
    },
  );
  it("reports completed restoration cleanup accurately and restores earlier shadows", async () => {
    await using workspace = await createOpenShellTestWorkspace("workspace");
    await using agentWorkspace = await createOpenShellTestWorkspace("agent-workspace");
    const skillsDir = path.join(workspace.dir, ".openclaw", "sandbox-skills");
    const agentShadowDir = path.join(workspace.dir, "nested", "agent");
    for (const directory of [skillsDir, agentShadowDir]) {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "note.txt"), path.basename(directory), "utf8");
    }
    cliMocks.runOpenShellCli.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const preservationRoots = new Set<string>();
    let failedCleanupRoot: string | undefined;
    let cleanupFailed = false;
    const cleanupError = Object.assign(new Error("preservation directory cleanup denied"), {
      code: "EACCES",
    });
    const rename = fs.rename;
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (path.basename(String(to)) === "shadow") {
        const preserveRoot = path.dirname(String(to));
        preservationRoots.add(preserveRoot);
        if (String(from) === skillsDir) {
          failedCleanupRoot = preserveRoot;
        }
      }
    });
    const rmdir = fs.rmdir;
    const rmdirSpy = vi.spyOn(fs, "rmdir").mockImplementation(async (...args) => {
      if (String(args[0]) === failedCleanupRoot) {
        const leftover = expectDefined(failedCleanupRoot, "completed restoration cleanup root");
        await expect(fs.readdir(leftover)).resolves.toEqual([]);
        await expectPathMissing(path.join(leftover, "shadow"));
        await expect(fs.readFile(path.join(skillsDir, "note.txt"), "utf8")).resolves.toBe(
          "sandbox-skills",
        );
        cleanupFailed = true;
        throw cleanupError;
      }
      return await rmdir(...args);
    });
    const backend = await createOpenShellBackendFixture({
      workspaceDir: workspace.dir,
      agentWorkspaceDir: agentWorkspace.dir,
      remoteAgentWorkspaceDir: "/sandbox/nested/agent",
      mode: "mirror",
    });
    try {
      const result = await finalizeMirror(backend).catch((error: unknown) => error);
      expect(cleanupFailed).toBe(true);
      expect(preservationRoots.size).toBe(2);
      expect(result).toMatchObject({ cause: cleanupError });
      for (const directory of [skillsDir, agentShadowDir]) {
        await expect(fs.readFile(path.join(directory, "note.txt"), "utf8")).resolves.toBe(
          path.basename(directory),
        );
      }
      const leftover = expectDefined(failedCleanupRoot, "retained preservation directory");
      expect(String(result)).toContain(leftover);
      expect(String(result)).not.toContain(path.join(leftover, "shadow"));
      expect(String(result)).toContain("was restored");
    } finally {
      renameSpy.mockRestore();
      rmdirSpy.mockRestore();
      for (const directory of preservationRoots) {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  });
});

const executableWorkspaces: TempWorkspace[] = [];

async function makeExecutable(params: { name: string; script: string }): Promise<string> {
  const workspace = await createOpenShellTestWorkspace("bin");
  executableWorkspaces.push(workspace);
  const dir = workspace.dir;
  const file = path.join(dir, params.name);
  const logPath = path.join(dir, "openshell.log");
  await fs.writeFile(file, params.script.replaceAll("__LOG__", logPath), { mode: 0o755 });
  await fs.chmod(file, 0o755);
  process.env.OPEN_SHELL_CLI_TEST_LOG = logPath;
  return file;
}

async function readOpenShellSshConfig(params: {
  configText: string;
  gatewayEndpoint: string;
  workspace?: string;
}): Promise<string> {
  const command = await makeExecutable({
    name: "openshell-ssh-config",
    script: [
      "#!/bin/sh",
      "cat <<'OPENCLAW_SSH_CONFIG'",
      params.configText,
      "OPENCLAW_SSH_CONFIG",
    ].join("\n"),
  });
  const session = await createOpenShellSshSession({
    context: {
      sandboxName: "demo",
      config: resolveOpenShellPluginConfig({
        command,
        gatewayEndpoint: params.gatewayEndpoint,
        workspace: params.workspace,
      }),
    },
  });
  try {
    return await fs.readFile(session.configPath, "utf8");
  } finally {
    await disposeSshSandboxSession(session);
  }
}

afterEach(async () => {
  await Promise.all(executableWorkspaces.splice(0).map((workspace) => workspace.cleanup()));
});

async function finalizeMirror(backend: OpenShellSandboxBackend): Promise<void> {
  await backend.finalizeExec?.({
    status: "completed",
    exitCode: 0,
    timedOut: false,
    token: undefined,
  });
}

async function createOpenShellBackendFixture(params: {
  workspaceDir: string;
  mode: "mirror" | "remote";
  skillsWorkspaceDir?: string;
  agentWorkspaceDir?: string;
  remoteAgentWorkspaceDir?: string;
}): Promise<OpenShellSandboxBackend> {
  const factory = createOpenShellSandboxBackendFactory({
    pluginConfig: resolveOpenShellPluginConfig({
      command: "openshell",
      mode: params.mode,
      ...(params.remoteAgentWorkspaceDir
        ? { remoteAgentWorkspaceDir: params.remoteAgentWorkspaceDir }
        : {}),
    }),
  });
  return (await factory({
    sessionKey: "agent:main:turn",
    scopeKey: "agent:main",
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir ?? params.workspaceDir,
    ...(params.skillsWorkspaceDir ? { skillsWorkspaceDir: params.skillsWorkspaceDir } : {}),
    cfg: createOpenShellBackendSandboxConfig(),
  })) as OpenShellSandboxBackend;
}

describe("openshell fs bridges", () => {
  beforeAll(installOpenShellBackendMocks);
  afterAll(uninstallOpenShellBackendMocks);
  beforeEach(resetOpenShellBackendMocks);

  it("rejects workspace container paths that escape the managed root", async () => {
    const filePath = "/sandbox/nested/../../outside.txt";
    await using workspace = await createOpenShellTestWorkspace("fs-path");
    const { bridge } = await createMirrorFsBridgeFixture(workspace.dir);

    expect(() => bridge.resolvePath({ filePath })).toThrow("Sandbox path escapes allowed mounts");
    await expect(bridge.readDirectory({ filePath })).rejects.toThrow(
      "Sandbox path escapes allowed mounts",
    );
  });

  it("rejects agent container paths that escape the managed root", async () => {
    await using workspace = await createOpenShellTestWorkspace("fs-path");
    await using agentWorkspace = await createOpenShellTestWorkspace("fs-agent");
    const sandbox = createSandboxTestContext({
      overrides: {
        backendId: "openshell",
        workspaceDir: workspace.dir,
        agentWorkspaceDir: agentWorkspace.dir,
        workspaceAccess: "rw",
        containerWorkdir: "/sandbox",
      },
    });
    const { createOpenShellFsBridge } = await import("./fs-bridge.js");
    const bridge = createOpenShellFsBridge({ sandbox, backend: createMirrorBackendMock() });

    expect(() => bridge.resolvePath({ filePath: "/agent/../outside.txt" })).toThrow(
      "Sandbox path escapes allowed mounts",
    );
  });

  it.each(["remote", "mirror"] as const)(
    "keeps the factory backend as the canonical owner of the %s filesystem bridge",
    async (mode) => {
      await using workspace = await createOpenShellTestWorkspace("fs-owner");
      const workspaceDir = workspace.dir;
      sandboxMocks.remoteRoot = workspaceDir;
      sandboxMocks.remoteAgentRoot = workspaceDir;
      cliMocks.runOpenShellCli.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
      const backend = await createOpenShellBackendFixture({ workspaceDir, mode });
      const sandbox = createSandboxTestContext({
        overrides: {
          backendId: "openshell",
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          containerWorkdir: "/sandbox",
        },
      });
      const bridge = backend.createFsBridge?.({ sandbox });
      if (!bridge) {
        throw new Error("Expected an OpenShell filesystem bridge");
      }
      expect(bridge.pathMappings).toContainEqual({
        hostRoot: path.resolve(workspaceDir),
        containerRoot: "/sandbox",
      });
      expect(bridge.resolvePath({ filePath: "owner.txt" })).toEqual({
        ...(mode === "mirror" ? { hostPath: path.join(workspaceDir, "owner.txt") } : {}),
        relativePath: "owner.txt",
        containerPath: "/sandbox/owner.txt",
      });

      if (mode === "remote") {
        const runRemoteShellScript = vi.spyOn(backend, "runRemoteShellScript").mockResolvedValue({
          stdout: Buffer.from("0\n"),
          stderr: Buffer.alloc(0),
          code: 0,
        });
        await expect(bridge.stat({ filePath: "owner.txt" })).resolves.toBeNull();
        expect(runRemoteShellScript).toHaveBeenCalledOnce();
        return;
      }

      await bridge.writeFile({ filePath: "owner.txt", data: "owner" });
      await expect(fs.readFile(path.join(workspaceDir, "owner.txt"), "utf8")).resolves.toBe(
        "owner",
      );
      expect(cliMocks.runOpenShellCli).toHaveBeenLastCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({ sandboxName: backend.runtimeId }),
          args: [
            "sandbox",
            "upload",
            "--no-git-ignore",
            backend.runtimeId,
            path.join(workspaceDir, "owner.txt"),
            "/sandbox/owner.txt",
          ],
        }),
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves remote mirror mutation boundaries through the guest filesystem",
    async () => {
      await using stateWorkspace = await createOpenShellTestWorkspace("remote-pin");
      const stateDir = stateWorkspace.dir;
      const remoteRoot = path.join(stateDir, "sandbox");
      const remoteAgentRoot = path.join(stateDir, "agent");
      const hostRoot = path.join(stateDir, "host");
      const outsideDir = path.join(stateDir, "outside");
      await fs.mkdir(remoteRoot, { recursive: true });
      await fs.mkdir(remoteAgentRoot, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.mkdir(hostRoot, { recursive: true });
      await fs.mkdir(path.join(hostRoot, "alias"), { recursive: true });
      await fs.writeFile(path.join(hostRoot, "source.txt"), "payload", "utf8");
      await fs.writeFile(path.join(remoteRoot, "source.txt"), "payload", "utf8");
      await fs.symlink(outsideDir, path.join(remoteRoot, "alias"));
      sandboxMocks.remoteRoot = remoteRoot;
      sandboxMocks.remoteAgentRoot = remoteAgentRoot;
      cliMocks.runOpenShellCli.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
      const backend = await createOpenShellBackendFixture({
        workspaceDir: hostRoot,
        mode: "mirror",
      });
      const bridge = backend.createFsBridge?.({
        sandbox: createSandboxTestContext({
          overrides: {
            backendId: "openshell",
            workspaceDir: hostRoot,
            agentWorkspaceDir: hostRoot,
            containerWorkdir: "/sandbox",
            backend,
          },
        }),
      });
      if (!bridge) {
        throw new Error("Expected OpenShell mirror filesystem bridge");
      }

      await expect(bridge.mkdirp({ filePath: "/sandbox/safe/nested" })).resolves.toBeUndefined();
      await expect(fs.stat(path.join(remoteRoot, "safe", "nested"))).resolves.toBeDefined();

      await expect(bridge.mkdirp({ filePath: "/sandbox/..cache/file" })).resolves.toBeUndefined();
      await expect(fs.stat(path.join(remoteRoot, "..cache", "file"))).resolves.toBeDefined();

      await expect(bridge.mkdirp({ filePath: "/sandbox/alias/escaped" })).rejects.toThrow();
      await expectPathMissing(path.join(outsideDir, "escaped"));

      await expect(
        bridge.rename({ from: "/sandbox/source.txt", to: "/sandbox/alias/escaped.txt" }),
      ).rejects.toThrow();
      await expect(fs.readFile(path.join(remoteRoot, "source.txt"), "utf8")).resolves.toBe(
        "payload",
      );
      await expectPathMissing(path.join(outsideDir, "escaped.txt"));

      await fs.writeFile(path.join(remoteRoot, "victim.txt"), "delete me", "utf8");
      await expect(
        bridge.remove({ filePath: "/sandbox/alias/victim.txt", recursive: false }),
      ).rejects.toThrow();
      for (const recursive of [false, true]) {
        await expect(
          bridge.remove({ filePath: "/sandbox/missing-parent/victim.txt", recursive, force: true }),
        ).resolves.toBeUndefined();
        await expect(
          bridge.remove({
            filePath: "/sandbox/missing-parent/victim.txt",
            recursive,
            force: false,
          }),
        ).rejects.toThrow();
      }
      await expect(
        bridge.remove({ filePath: "/sandbox/alias/victim.txt", recursive: false, force: true }),
      ).rejects.toThrow();
      await expect(fs.readFile(path.join(remoteRoot, "victim.txt"), "utf8")).resolves.toBe(
        "delete me",
      );
      await expectPathMissing(path.join(outsideDir, "victim.txt"));

      await fs.symlink(outsideDir, path.join(remoteRoot, "rename-link"));
      await fs.mkdir(path.join(remoteRoot, "rename-directory"));
      for (const target of ["rename-link", "rename-directory"]) {
        await expect(bridge.rename({ from: "source.txt", to: target })).rejects.toThrow(
          "unsafe remote rename target",
        );
      }
      await expect(fs.readlink(path.join(remoteRoot, "rename-link"))).resolves.toBe(outsideDir);
      await expect(fs.readdir(path.join(remoteRoot, "rename-directory"))).resolves.toEqual([]);
      await expect(fs.readFile(path.join(hostRoot, "source.txt"), "utf8")).resolves.toBe("payload");
      const renamed = "nested/renamed 'file'.txt";
      await bridge.rename({ from: "source.txt", to: renamed });
      for (const rootDir of [hostRoot, remoteRoot]) {
        await expectPathMissing(path.join(rootDir, "source.txt"));
        await expect(fs.readFile(path.join(rootDir, renamed), "utf8")).resolves.toBe("payload");
      }

      const outsideTarget = path.join(outsideDir, "target.txt");
      await fs.writeFile(outsideTarget, "outside");
      for (const recursive of [false, true]) {
        for (const rootDir of [hostRoot, remoteRoot]) {
          await fs.symlink(outsideTarget, path.join(rootDir, "link.txt"));
        }
        await bridge.remove({ filePath: "link.txt", recursive, force: false });
        await expect(fs.lstat(path.join(remoteRoot, "link.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("outside");
      await fs.writeFile(path.join(hostRoot, "missing-remotely.txt"), "local");
      await bridge.remove({ filePath: "missing-remotely.txt", force: false });
      await expectPathMissing(path.join(hostRoot, "missing-remotely.txt"));

      await fs.rm(remoteRoot, { recursive: true });
      await bridge.remove({ filePath: "missing-root/file.txt", force: true });
      await expectPathMissing(remoteRoot);
      await bridge.mkdirp({ filePath: "recreated" });
      await expect(fs.readdir(remoteRoot)).resolves.toEqual(["recreated"]);
      await fs.rm(remoteRoot, { recursive: true });
      await fs.symlink(outsideDir, remoteRoot);
      sandboxMocks.remoteRoot = `${remoteRoot}/`;
      await expect(bridge.mkdirp({ filePath: "escaped" })).rejects.toThrow("unsafe remote root");
      await expect(fs.readdir(outsideDir)).resolves.toEqual(["target.txt"]);
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
