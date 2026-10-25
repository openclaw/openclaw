import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import type { CreateSandboxBackendParams, SandboxBackendHandle } from "./backend.types.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import type { SandboxConfig } from "./types.js";

const sshMocks = vi.hoisted(() => ({
  openSession: vi.fn<typeof import("./ssh.js").createSshSandboxSessionFromSettings>(),
  disposeSession: vi.fn<typeof import("./ssh.js").disposeSshSandboxSession>(),
  runCommand: vi.fn<typeof import("./ssh.js").runSshSandboxCommand>(),
  upload: vi.fn<typeof import("./ssh.js").uploadDirectoryToSshTarget>(),
  spawn: vi.fn(),
}));

vi.mock("../../process/exec.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../process/exec.js")>("../../process/exec.js");
  return { ...actual, spawnCommand: sshMocks.spawn };
});

vi.mock("./ssh.js", async () => {
  const actual = await vi.importActual<typeof import("./ssh.js")>("./ssh.js");
  return {
    ...actual,
    createSshSandboxSessionFromSettings: sshMocks.openSession,
    disposeSshSandboxSession: sshMocks.disposeSession,
    runSshSandboxCommand: sshMocks.runCommand,
    uploadDirectoryToSshTarget: sshMocks.upload,
  };
});

const {
  createPreprovisionedSshSandboxBackend,
  createSshSandboxBackend,
  resolveSshRuntimePaths,
  sshSandboxBackendManager,
} = await import("./ssh-backend.js");
const tempDirs = createTempDirTracker();

function createConfig(): OpenClawConfig {
  const { mode, backend, scope, workspaceAccess, ssh } = createBackendSandboxConfig({
    target: "peter@example.com:2222",
  });
  return { agents: { defaults: { sandbox: { mode, backend, scope, workspaceAccess, ssh } } } };
}

function createSession() {
  return {
    command: "ssh",
    configPath: path.join(os.tmpdir(), "openclaw-test-ssh-config"),
    host: "openclaw-sandbox",
  };
}

function runtimeEntry(scope = "worker") {
  const runtimeId = `openclaw-ssh-${scope}-abcd1234`;
  return {
    containerName: runtimeId,
    backendId: "ssh",
    runtimeLabel: runtimeId,
    sessionKey: scope === "shared" ? "shared" : `agent:${scope}`,
    createdAtMs: 1,
    lastUsedAtMs: 1,
    image: "peter@example.com:2222",
    configLabelKind: "Target",
  };
}

function commandResult(stdout = "", stderr = "", code = 0) {
  return { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), code };
}

const secretRef = (id: string) => ({ source: "env" as const, provider: "default", id });
function markCold(agent: string, configPath: string, id: string) {
  setActiveDegradedSecretOwners([
    {
      ownerKind: "capability",
      ownerId: `agent-sandbox:${agent}`,
      state: "unavailable",
      paths: [configPath],
      refKeys: [`env:default:${id}`],
      reason: "secret reference was not found",
    },
  ]);
}
const unavailable = (owner: string) => ({
  code: "SECRET_SURFACE_UNAVAILABLE",
  ownerKind: "capability",
  ownerId: `agent-sandbox:${owner}`,
});

const spawnResult = {
  failed: false,
  isCanceled: false,
  exitCode: 0,
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
};
const defaultExec = { command: "pwd", env: {}, usePty: false };

function finalize(backend: SandboxBackendHandle, spec: { finalizeToken?: unknown }) {
  return backend.finalizeExec?.({
    status: "completed",
    exitCode: 0,
    timedOut: false,
    token: spec.finalizeToken,
  });
}

const commandAt = (index = 0) => sshMocks.runCommand.mock.calls[index]![0];
const settingsAt = () => sshMocks.openSession.mock.calls[0]![0];
function expectUpload(callIndex: number, localDir: string, remoteDir: string) {
  expect(sshMocks.upload.mock.calls[callIndex]![0]).toMatchObject({
    localDir,
    remoteDir: expect.stringContaining(remoteDir),
  });
}

function requirePreparedSshInvocation(callIndex = 0): { argv: string[]; stdin: string } {
  const call = sshMocks.spawn.mock.calls[callIndex];
  if (!Array.isArray(call?.[0])) {
    throw new Error(`expected staged ssh invocation ${callIndex}`);
  }
  const input: unknown = call[1]?.input;
  if (typeof input !== "string" && !Buffer.isBuffer(input)) {
    throw new Error(`expected staged ssh stdin for invocation ${callIndex}`);
  }
  return {
    argv: call[0] as string[],
    stdin: typeof input === "string" ? input : input.toString("utf8"),
  };
}

function createBackendSandboxConfig(params?: { binds?: string[]; target?: string }): SandboxConfig {
  return resolveSandboxConfigForAgent(
    {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "ssh",
            scope: "session",
            workspaceAccess: "rw",
            ssh: { workspaceRoot: "/remote/openclaw", target: params?.target },
            docker: { binds: params?.binds },
          },
        },
      },
    },
    "worker",
  );
}

async function skillsFixture() {
  const skillsWorkspaceDir = tempDirs.make("openclaw-ssh-skills-");
  await fs.mkdir(path.join(skillsWorkspaceDir, "skills", "demo"), { recursive: true });
  const runtimePaths = resolveSshRuntimePaths("/remote/openclaw", "agent:worker");
  const skillsWorkdir = path.posix.join(runtimePaths.remoteSkillsWorkspaceDir, "skills", "demo");
  return { skillsWorkspaceDir, runtimePaths, skillsWorkdir };
}

function revocableBackend() {
  let current = true;
  return {
    revoke: () => {
      current = false;
    },
    backend: createBackend({
      assertRuntimeCurrent: () => {
        if (!current) {
          throw new Error("runtime removed");
        }
      },
    }),
  };
}

function createBackendParams(
  cfg = createBackendSandboxConfig({ target: "peter@example.com:2222" }),
  overrides: Partial<CreateSandboxBackendParams> = {},
): CreateSandboxBackendParams {
  return {
    sessionKey: "agent:worker:task",
    scopeKey: "agent:worker",
    workspaceDir: "/tmp/workspace",
    agentWorkspaceDir: "/tmp/workspace",
    cfg,
    ...overrides,
  };
}

function createBackend(overrides: Partial<CreateSandboxBackendParams> = {}) {
  return createSshSandboxBackend(createBackendParams(undefined, overrides));
}

function createPreprovisionedBackend(overrides: Partial<CreateSandboxBackendParams> = {}) {
  return createPreprovisionedSshSandboxBackend(createBackendParams(undefined, overrides), {
    runtimeId: "remote-exec:environment-1:7:11",
    remoteWorkspaceDir: "/srv/openclaw/workspaces/session-1",
  });
}

describe("ssh sandbox backend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActiveDegradedSecretOwners([]);
    sshMocks.openSession.mockResolvedValue(createSession());
    sshMocks.disposeSession.mockResolvedValue(undefined);
    sshMocks.runCommand.mockResolvedValue(commandResult("1\n"));
    sshMocks.upload.mockResolvedValue(undefined);
    sshMocks.spawn.mockResolvedValue(spawnResult);
  });

  afterEach(async () => {
    setActiveDegradedSecretOwners([]);
    vi.unstubAllEnvs();
    tempDirs.cleanup();
    vi.restoreAllMocks();
  });

  it("preserves shared runtime identity and hashes workspace-qualified scopes", () => {
    expect(resolveSshRuntimePaths("/remote/openclaw", "shared").runtimeId).toBe(
      "openclaw-ssh-shared-8198076c",
    );
    expect(
      resolveSshRuntimePaths("/remote/openclaw", `agent:main:workspace:${"a".repeat(32)}`)
        .runtimeId,
    ).toMatch(/^openclaw-ssh-workspace-[a-f0-9]{32}$/);
  });

  it("uses the derived registry agent for both validation and SSH settings", async () => {
    const config = createConfig();
    config.agents!.defaults!.sandbox!.ssh!.identityData = secretRef(
      "UNMATERIALIZED_DEFAULT_IDENTITY",
    );
    config.agents!.entries = {
      worker: {
        sandbox: {
          ssh: {
            identityData: "MATERIALIZED WORKER IDENTITY",
          },
        },
      },
    };

    const result = await sshSandboxBackendManager.describeRuntime({
      entry: runtimeEntry(),
      config,
    });
    expect(result).toEqual({
      running: true,
      actualConfigLabel: "peter@example.com:2222",
      configLabelMatch: true,
    });
    expect(settingsAt()).toMatchObject({
      target: "peter@example.com:2222",
      workspaceRoot: "/remote/openclaw",
      identityData: "MATERIALIZED WORKER IDENTITY",
    });
    expect(commandAt().remoteCommand).toContain("/remote/openclaw/openclaw-ssh-agent-worker");
  });

  it("rejects a cold agent owner before opening an SSH management session", async () => {
    markCold("worker", "agents.defaults.sandbox.ssh.identityData", "MISSING_SSH_IDENTITY");

    await expect(
      sshSandboxBackendManager.describeRuntime({
        entry: runtimeEntry(),
        config: createConfig(),
        agentId: "worker",
      }),
    ).rejects.toMatchObject(unavailable("worker"));
    expect(sshMocks.openSession).not.toHaveBeenCalled();
  });

  it("rejects unmaterialized shared SSH refs even when no active owner inherited them", async () => {
    const config = createConfig();
    config.agents!.defaults!.sandbox!.mode = "off";
    config.agents!.defaults!.sandbox!.scope = "shared";
    config.agents!.defaults!.sandbox!.ssh!.identityData = secretRef("MISSING_SHARED_SSH_IDENTITY");

    await expect(
      sshSandboxBackendManager.removeRuntime({
        entry: runtimeEntry("shared"),
        config,
      }),
    ).rejects.toMatchObject(unavailable("shared"));
    expect(sshMocks.openSession).not.toHaveBeenCalled();
  });

  it("does not block shared SSH management for an unrelated cold agent override", async () => {
    markCold("cold", "agents.entries.cold.sandbox.ssh.identityData", "MISSING_AGENT_SSH_IDENTITY");
    const config = createConfig();
    config.agents!.defaults!.sandbox!.scope = "shared";

    await sshSandboxBackendManager.removeRuntime({
      entry: runtimeEntry("shared"),
      config,
    });

    expect(sshMocks.openSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["permission denied", "permission denied"],
    ["", "exit 1"],
  ])(
    "rejects failed SSH runtime removal instead of orphaning its registry entry: %s",
    async (stderr, expected) => {
      sshMocks.runCommand.mockResolvedValueOnce(commandResult("", stderr, 1));

      await expect(
        sshSandboxBackendManager.removeRuntime({
          entry: runtimeEntry(),
          config: createConfig(),
        }),
      ).rejects.toThrow(expected);
      expect(commandAt()).toMatchObject({
        allowFailure: true,
        remoteCommand: expect.stringContaining('rm -rf -- "$1"'),
      });
      expect(sshMocks.disposeSession).toHaveBeenCalledOnce();
    },
  );

  it("uploads SSH exec environment privately without exposing values in local argv", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-secret");
    vi.stubEnv("LANG", "en_US.UTF-8");
    const sentinel = "synthetic-ssh-private-value";
    const multilineValue = `${sentinel}\r\nsecond 'quoted' line=ok `;
    const backend = await createPreprovisionedBackend();

    const execSpec = await backend.buildExecSpec({
      command: "printf '%s' \"$SYNTHETIC_VALUE\"",
      env: { SYNTHETIC_VALUE: multilineValue },
      usePty: true,
    });

    expect(execSpec.argv.join(" ")).not.toContain(sentinel);
    expect(execSpec.env?.OPENAI_API_KEY).toBeUndefined();
    expect(execSpec.env?.LANG).toBe("en_US.UTF-8");
    expect(execSpec.argv).toContain("-tt");
    expect(execSpec.stdinMode).toBe("pipe-open");
    const upload = requirePreparedSshInvocation();
    expect(upload.argv.join(" ")).not.toContain(sentinel);
    expect(upload.argv).toContain("-T");
    expect(upload.stdin).toContain(sentinel);
    expect(upload.stdin).toContain("second '");
    expect(upload.stdin).toMatch(/(?:^|\n)export SYNTHETIC_VALUE=/);
    expect(upload.stdin).toMatch(/exec '\/bin\/sh' '-c'/);
    expect(upload.stdin).toContain("export TERM='xterm-256color'");
    expect(execSpec.argv.join(" ")).not.toContain("SetEnv");

    await finalize(backend, execSpec);

    expect(sshMocks.spawn).toHaveBeenCalledTimes(2);
    const cleanup = requirePreparedSshInvocation(1);
    expect(cleanup.argv.at(-1)).toContain("openclaw-sandbox-exec-cleanup");
    expect(cleanup.argv.join(" ")).not.toContain(sentinel);
    expect(sshMocks.disposeSession).toHaveBeenCalledOnce();
  });

  it("finalizes only its own prepared exec once and ignores forged or foreign tokens", async () => {
    const params = createBackendParams(
      createBackendSandboxConfig({ target: "worker@example.com:22" }),
    );
    const workdir = { runtimeId: "owned-finalization", remoteWorkspaceDir: "/remote/workspace" };
    const owner = await createPreprovisionedSshSandboxBackend(params, workdir);
    const foreign = await createPreprovisionedSshSandboxBackend(params, workdir);
    const spec = await owner.buildExecSpec({ command: "true", env: {}, usePty: false });
    const forgedCleanup = vi.fn(async () => {});
    const outcome = { status: "completed" as const, exitCode: 0, timedOut: false };

    await foreign.finalizeExec?.({ ...outcome, token: spec.finalizeToken });
    await owner.finalizeExec?.({
      ...outcome,
      token: { cleanup: forgedCleanup, session: { dispose: forgedCleanup } },
    });
    expect(forgedCleanup).not.toHaveBeenCalled();
    expect(sshMocks.spawn).toHaveBeenCalledOnce();
    expect(sshMocks.disposeSession).not.toHaveBeenCalled();

    await Promise.all([
      owner.finalizeExec?.({ ...outcome, token: spec.finalizeToken }),
      owner.finalizeExec?.({ ...outcome, token: spec.finalizeToken }),
    ]);
    await owner.finalizeExec?.({ ...outcome, token: spec.finalizeToken });
    expect(sshMocks.spawn).toHaveBeenCalledTimes(2);
    expect(sshMocks.disposeSession).toHaveBeenCalledOnce();
  });

  it("disposes the SSH session when staged exec upload or final cleanup fails", async () => {
    const backend = await createPreprovisionedBackend();

    sshMocks.spawn.mockRejectedValueOnce(new Error("synthetic staging transport failure"));
    await expect(
      backend.buildExecSpec({
        command: "true",
        env: { SYNTHETIC_VALUE: "synthetic-upload-value" },
        usePty: false,
      }),
    ).rejects.toThrow("synthetic staging transport failure");
    expect(sshMocks.spawn).toHaveBeenCalledTimes(2);
    expect(sshMocks.disposeSession).toHaveBeenCalledOnce();

    const execSpec = await backend.buildExecSpec({ ...defaultExec, command: "true" });
    sshMocks.spawn.mockRejectedValueOnce(new Error("synthetic cleanup transport failure"));
    await expect(
      backend.finalizeExec?.({
        status: "failed",
        exitCode: null,
        timedOut: true,
        token: execSpec.finalizeToken,
      }),
    ).rejects.toThrow("synthetic cleanup transport failure");
    expect(sshMocks.disposeSession).toHaveBeenCalledTimes(2);
    expect(sshMocks.spawn.mock.invocationCallOrder.at(-1)).toBeLessThan(
      sshMocks.disposeSession.mock.invocationCallOrder.at(-1) ?? Number.POSITIVE_INFINITY,
    );
  });

  it("creates a remote-canonical backend that seeds once and reuses ssh exec", async () => {
    sshMocks.runCommand
      .mockResolvedValueOnce(commandResult("0\n"))
      .mockResolvedValueOnce(commandResult())
      .mockResolvedValueOnce(commandResult());
    const { skillsWorkspaceDir } = await skillsFixture();
    const cfg = createBackendSandboxConfig({ target: "peter@example.com:2222" });
    cfg.docker.env = { LANG: "C.UTF-8" };

    const backend = await createBackend({
      agentWorkspaceDir: "/tmp/agent",
      skillsWorkspaceDir,
      cfg,
    });

    const execSpec = await backend.buildExecSpec({
      command: "pwd",
      env: { TEST_TOKEN: "1" },
      usePty: false,
    });

    expect(execSpec.argv.slice(0, 4)).toEqual(["ssh", "-F", createSession().configPath, "-T"]);
    expect(execSpec.argv).toContain(createSession().host);
    expect(requirePreparedSshInvocation().stdin).toContain(
      "/remote/openclaw/openclaw-ssh-agent-worker",
    );
    expect(sshMocks.upload).toHaveBeenCalledTimes(3);
    expectUpload(0, "/tmp/workspace", "/workspace");
    expectUpload(1, "/tmp/agent", "/agent");
    expectUpload(2, skillsWorkspaceDir, "/workspace/.openclaw/sandbox-skills");

    await finalize(backend, execSpec);
    expect(sshMocks.openSession).toHaveBeenCalledTimes(2);
    expect(sshMocks.disposeSession).toHaveBeenCalledTimes(2);
  });

  it("does not contact the remote runtime when authority is revoked during session setup", async () => {
    const { backend: pending, revoke } = revocableBackend();
    const backend = await pending;
    sshMocks.openSession.mockImplementation(async () => {
      revoke();
      return createSession();
    });
    await expect(backend.runShellCommand({ script: "printf stale" })).rejects.toThrow(
      "runtime removed",
    );
    expect(sshMocks.runCommand).not.toHaveBeenCalled();
    expect(sshMocks.upload).not.toHaveBeenCalled();
    expect(sshMocks.spawn).not.toHaveBeenCalled();
    expect(sshMocks.disposeSession).toHaveBeenCalledOnce();
  });

  it.each(["upload", "admission"])(
    "discards staged exec when runtime authority is revoked during %s",
    async (stage) => {
      const { backend: pending, revoke } = revocableBackend();
      const backend = await pending;
      sshMocks.spawn.mockImplementationOnce(async () => {
        if (stage === "upload") {
          revoke();
        }
        return spawnResult;
      });

      const preparing = backend.buildExecSpec({ command: "printf stale", env: {}, usePty: false });
      if (stage === "upload") {
        await expect(preparing).rejects.toThrow("runtime removed");
      } else {
        const spec = await preparing;
        revoke();
        expect(() => spec.assertCurrent?.()).toThrow("runtime removed");
        await backend.finalizeExec?.({
          status: "failed",
          exitCode: null,
          timedOut: false,
          token: spec.finalizeToken,
        });
      }

      expect(sshMocks.spawn).toHaveBeenCalledTimes(2);
      expect(requirePreparedSshInvocation(1).argv.at(-1)).toContain(
        "openclaw-sandbox-exec-cleanup",
      );
      expect(sshMocks.disposeSession).toHaveBeenCalledTimes(2);
    },
  );

  it("adopts a preprovisioned workdir without clearing or uploading placement files", async () => {
    const remoteWorkspaceDir = "/srv/openclaw/workspaces/session-1";
    const backend = await createPreprovisionedBackend({
      agentWorkspaceDir: "/tmp/agent",
      skillsWorkspaceDir: "/tmp/skills",
    });

    expect(backend.runtimeId).toBe("remote-exec:environment-1:7:11");
    expect(backend.workdir).toBe(remoteWorkspaceDir);
    expect(backend.workdirRoots).toEqual([remoteWorkspaceDir]);

    const execSpec = await backend.buildExecSpec(defaultExec);

    expect(requirePreparedSshInvocation().stdin).toContain(remoteWorkspaceDir);
    expect(sshMocks.upload).not.toHaveBeenCalled();
    expect(sshMocks.runCommand).not.toHaveBeenCalled();
    await backend.runShellCommand({ script: "pwd" });
    expect(sshMocks.upload).not.toHaveBeenCalled();
    expect(String(commandAt().remoteCommand)).not.toContain("openclaw-sandbox-clear");

    await finalize(backend, execSpec);
  });

  it.each([false, true])(
    "refreshes a validated skills workdir (discarded: %s)",
    async (discard) => {
      const { skillsWorkspaceDir, runtimePaths, skillsWorkdir } = await skillsFixture();
      sshMocks.runCommand
        .mockResolvedValueOnce(commandResult("1\n"))
        .mockResolvedValueOnce(commandResult())
        .mockResolvedValueOnce(commandResult(`${skillsWorkdir}\n`));

      const backend = await createBackend({ skillsWorkspaceDir });

      await expect(backend.validateWorkdir?.(skillsWorkdir)).resolves.toBe(skillsWorkdir);
      if (discard) {
        backend.discardPreparedWorkdir?.(skillsWorkdir);
        sshMocks.runCommand.mockResolvedValueOnce(commandResult());
      }
      const execSpec = await backend.buildExecSpec({ ...defaultExec, workdir: skillsWorkdir });
      expect(sshMocks.upload).toHaveBeenCalledTimes(discard ? 2 : 1);
      expect(sshMocks.upload.mock.calls[0]![0]).toMatchObject({
        localDir: skillsWorkspaceDir,
        remoteDir: runtimePaths.remoteSkillsWorkspaceDir,
      });
      expect(requirePreparedSshInvocation().stdin).toContain(skillsWorkdir);
      await finalize(backend, execSpec);
    },
  );

  it("refreshes materialized skills before each exec and remote fs command", async () => {
    const { skillsWorkspaceDir } = await skillsFixture();
    const backend = await createBackend({ skillsWorkspaceDir });

    const firstExec = await backend.buildExecSpec(defaultExec);
    const secondExec = await backend.buildExecSpec(defaultExec);
    await backend.runShellCommand({
      script: "printf ok",
    });

    expect(sshMocks.upload).toHaveBeenCalledTimes(3);
    expectUpload(0, skillsWorkspaceDir, "/workspace/.openclaw/sandbox-skills");
    await finalize(backend, firstExec);
    await finalize(backend, secondExec);
  });

  it("clears stale remote materialized skills when the local copy is missing", async () => {
    const tmpDir = tempDirs.make("openclaw-ssh-skills-");
    const skillsWorkspaceDir = path.join(tmpDir, "missing");
    const backend = await createBackend({ skillsWorkspaceDir });

    const execSpec = await backend.buildExecSpec(defaultExec);

    expect(sshMocks.upload).not.toHaveBeenCalled();
    const commandParams = commandAt(1);
    expect(commandParams.remoteCommand).toContain("openclaw-sandbox-clear");
    expect(commandParams.remoteCommand).toContain("/workspace/.openclaw/sandbox-skills");
    await finalize(backend, execSpec);
  });

  it("disposes the exec ssh session when materialized skills refresh fails", async () => {
    const { skillsWorkspaceDir } = await skillsFixture();
    const backend = await createBackend({ skillsWorkspaceDir });
    sshMocks.upload.mockRejectedValueOnce(new Error("upload failed"));

    await expect(backend.buildExecSpec(defaultExec)).rejects.toThrow("upload failed");

    expect(sshMocks.upload).toHaveBeenCalledTimes(1);
    expect(sshMocks.disposeSession).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      binds: ["/tmp:/tmp:rw"],
      target: "peter@example.com:22",
      error: "does not support sandbox.docker.binds",
    },
    { error: "requires agents.defaults.sandbox.ssh.target" },
  ])("rejects invalid SSH config: $error", async ({ error, ...params }) => {
    await expect(createBackend({ cfg: createBackendSandboxConfig(params) })).rejects.toThrow(error);
  });
});
