import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import { captureFullEnv } from "../../test-utils/env.js";
import type { CreateSandboxBackendParams, SandboxBackendHandle } from "./backend.types.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import type { SandboxConfig } from "./types.js";

const sshMocks = vi.hoisted(() => ({
  createSshSandboxSessionFromSettings: vi.fn(),
  disposeSshSandboxSession: vi.fn(),
  runSshSandboxCommand: vi.fn(),
  uploadDirectoryToSshTarget: vi.fn(),
  spawnCommand: vi.fn(),
}));

vi.mock("../../process/exec.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../process/exec.js")>("../../process/exec.js");
  return { ...actual, spawnCommand: sshMocks.spawnCommand };
});

vi.mock("./ssh.js", async () => {
  const actual = await vi.importActual<typeof import("./ssh.js")>("./ssh.js");
  return {
    ...actual,
    createSshSandboxSessionFromSettings: sshMocks.createSshSandboxSessionFromSettings,
    disposeSshSandboxSession: sshMocks.disposeSshSandboxSession,
    runSshSandboxCommand: sshMocks.runSshSandboxCommand,
    uploadDirectoryToSshTarget: sshMocks.uploadDirectoryToSshTarget,
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

const requireRecord = createRequireRecord("object", "expected-label");

function requireMockRecordArg(mock: ReturnType<typeof vi.fn>, callIndex: number, label: string) {
  return requireRecord(mock.mock.calls[callIndex]?.[0], label);
}

const commandAt = (index = 0) =>
  requireMockRecordArg(sshMocks.runSshSandboxCommand, index, "ssh command");
const settingsAt = () =>
  requireMockRecordArg(sshMocks.createSshSandboxSessionFromSettings, 0, "ssh settings");

function expectUpload(callIndex: number, localDir: string, remoteDir: string) {
  expect(
    requireMockRecordArg(sshMocks.uploadDirectoryToSshTarget, callIndex, "upload"),
  ).toMatchObject({
    localDir,
    remoteDir: expect.stringContaining(remoteDir),
  });
}

function requirePreparedSshInvocation(callIndex = 0): { argv: string[]; stdin: string } {
  const call = sshMocks.spawnCommand.mock.calls[callIndex];
  if (!Array.isArray(call?.[0])) {
    throw new Error(`expected staged ssh invocation ${callIndex}`);
  }
  const input = requireRecord(call[1], "staged ssh command options").input;
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

async function expectBackendCreationToReject(params: {
  binds?: string[];
  target?: string;
  error: string;
}) {
  await expect(
    createBackend({
      sessionKey: "s",
      scopeKey: "s",
      cfg: createBackendSandboxConfig(params),
    }),
  ).rejects.toThrow(params.error);
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
  let envSnapshot: ReturnType<typeof captureFullEnv>;

  beforeEach(() => {
    envSnapshot = captureFullEnv();
    vi.clearAllMocks();
    setActiveDegradedSecretOwners([]);
    sshMocks.createSshSandboxSessionFromSettings.mockResolvedValue(createSession());
    sshMocks.disposeSshSandboxSession.mockResolvedValue(undefined);
    sshMocks.runSshSandboxCommand.mockResolvedValue(commandResult("1\n"));
    sshMocks.uploadDirectoryToSshTarget.mockResolvedValue(undefined);
    sshMocks.spawnCommand.mockResolvedValue(spawnResult);
  });

  afterEach(async () => {
    setActiveDegradedSecretOwners([]);
    envSnapshot.restore();
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
    expect(sshMocks.createSshSandboxSessionFromSettings).not.toHaveBeenCalled();
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
    expect(sshMocks.createSshSandboxSessionFromSettings).not.toHaveBeenCalled();
  });

  it("does not block shared SSH management for an unrelated cold agent override", async () => {
    markCold("cold", "agents.entries.cold.sandbox.ssh.identityData", "MISSING_AGENT_SSH_IDENTITY");
    const config = createConfig();
    config.agents!.defaults!.sandbox!.scope = "shared";

    await sshSandboxBackendManager.removeRuntime({
      entry: runtimeEntry("shared"),
      config,
    });

    expect(sshMocks.createSshSandboxSessionFromSettings).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["permission denied", "permission denied"],
    ["", "exit 1"],
  ])(
    "rejects failed SSH runtime removal instead of orphaning its registry entry: %s",
    async (stderr, expected) => {
      sshMocks.runSshSandboxCommand.mockResolvedValueOnce(commandResult("", stderr, 1));

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
      expect(sshMocks.disposeSshSandboxSession).toHaveBeenCalledOnce();
    },
  );

  it("uploads SSH exec environment privately without exposing values in local argv", async () => {
    const sentinel = "synthetic-ssh-private-value";
    const multilineValue = `${sentinel}\r\nsecond 'quoted' line=ok `;
    const backend = await createPreprovisionedBackend();

    const execSpec = await backend.buildExecSpec({
      command: "printf '%s' \"$SYNTHETIC_VALUE\"",
      env: { SYNTHETIC_VALUE: multilineValue },
      usePty: true,
    });

    expect(execSpec.argv.join(" ")).not.toContain(sentinel);
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

    expect(sshMocks.spawnCommand).toHaveBeenCalledTimes(2);
    const cleanup = requirePreparedSshInvocation(1);
    expect(cleanup.argv.at(-1)).toContain("openclaw-sandbox-exec-cleanup");
    expect(cleanup.argv.join(" ")).not.toContain(sentinel);
    expect(sshMocks.disposeSshSandboxSession).toHaveBeenCalledOnce();
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
    expect(sshMocks.spawnCommand).toHaveBeenCalledOnce();
    expect(sshMocks.disposeSshSandboxSession).not.toHaveBeenCalled();

    await Promise.all([
      owner.finalizeExec?.({ ...outcome, token: spec.finalizeToken }),
      owner.finalizeExec?.({ ...outcome, token: spec.finalizeToken }),
    ]);
    await owner.finalizeExec?.({ ...outcome, token: spec.finalizeToken });
    expect(sshMocks.spawnCommand).toHaveBeenCalledTimes(2);
    expect(sshMocks.disposeSshSandboxSession).toHaveBeenCalledOnce();
  });

  it("disposes the SSH session when staged exec upload or final cleanup fails", async () => {
    const backend = await createPreprovisionedBackend();

    sshMocks.spawnCommand.mockRejectedValueOnce(new Error("synthetic staging transport failure"));
    await expect(
      backend.buildExecSpec({
        command: "true",
        env: { SYNTHETIC_VALUE: "synthetic-upload-value" },
        usePty: false,
      }),
    ).rejects.toThrow("synthetic staging transport failure");
    expect(sshMocks.spawnCommand).toHaveBeenCalledTimes(2);
    expect(sshMocks.disposeSshSandboxSession).toHaveBeenCalledOnce();

    const execSpec = await backend.buildExecSpec({ ...defaultExec, command: "true" });
    sshMocks.spawnCommand.mockRejectedValueOnce(new Error("synthetic cleanup transport failure"));
    await expect(
      backend.finalizeExec?.({
        status: "failed",
        exitCode: null,
        timedOut: true,
        token: execSpec.finalizeToken,
      }),
    ).rejects.toThrow("synthetic cleanup transport failure");
    expect(sshMocks.disposeSshSandboxSession).toHaveBeenCalledTimes(2);
    expect(sshMocks.spawnCommand.mock.invocationCallOrder.at(-1)).toBeLessThan(
      sshMocks.disposeSshSandboxSession.mock.invocationCallOrder.at(-1) ?? Number.POSITIVE_INFINITY,
    );
  });

  it("creates a remote-canonical backend that seeds once and reuses ssh exec", async () => {
    sshMocks.runSshSandboxCommand
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
    expect(sshMocks.uploadDirectoryToSshTarget).toHaveBeenCalledTimes(3);
    expectUpload(0, "/tmp/workspace", "/workspace");
    expectUpload(1, "/tmp/agent", "/agent");
    expectUpload(2, skillsWorkspaceDir, "/workspace/.openclaw/sandbox-skills");

    await finalize(backend, execSpec);
    expect(sshMocks.createSshSandboxSessionFromSettings).toHaveBeenCalledTimes(2);
    expect(sshMocks.disposeSshSandboxSession).toHaveBeenCalledTimes(2);
  });

  it("does not contact the remote runtime when authority is revoked during session setup", async () => {
    const { backend: pending, revoke } = revocableBackend();
    const backend = await pending;
    sshMocks.createSshSandboxSessionFromSettings.mockImplementation(async () => {
      revoke();
      return createSession();
    });
    await expect(backend.runShellCommand({ script: "printf stale" })).rejects.toThrow(
      "runtime removed",
    );
    expect(sshMocks.runSshSandboxCommand).not.toHaveBeenCalled();
    expect(sshMocks.uploadDirectoryToSshTarget).not.toHaveBeenCalled();
    expect(sshMocks.spawnCommand).not.toHaveBeenCalled();
    expect(sshMocks.disposeSshSandboxSession).toHaveBeenCalledOnce();
  });

  it.each(["upload", "admission"])(
    "discards staged exec when runtime authority is revoked during %s",
    async (stage) => {
      const { backend: pending, revoke } = revocableBackend();
      const backend = await pending;
      sshMocks.spawnCommand.mockImplementationOnce(async () => {
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

      expect(sshMocks.spawnCommand).toHaveBeenCalledTimes(2);
      expect(requirePreparedSshInvocation(1).argv.at(-1)).toContain(
        "openclaw-sandbox-exec-cleanup",
      );
      expect(sshMocks.disposeSshSandboxSession).toHaveBeenCalledTimes(2);
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
    expect(sshMocks.uploadDirectoryToSshTarget).not.toHaveBeenCalled();
    expect(sshMocks.runSshSandboxCommand).not.toHaveBeenCalled();
    await backend.runShellCommand({ script: "pwd" });
    expect(sshMocks.uploadDirectoryToSshTarget).not.toHaveBeenCalled();
    expect(String(commandAt().remoteCommand)).not.toContain("openclaw-sandbox-clear");

    await finalize(backend, execSpec);
  });

  it("validates remote workdirs before exec accepts backend-owned cwd", async () => {
    const root = "/remote/openclaw/openclaw-ssh-agent-worker-abcd1234";
    const workspaceSrc = `${root}/workspace/src`;
    const agentSrc = `${root}/agent/src`;
    sshMocks.runSshSandboxCommand
      .mockResolvedValueOnce(commandResult("1\n"))
      .mockResolvedValueOnce(commandResult(`${workspaceSrc}\n`))
      .mockResolvedValueOnce(commandResult("", "remote directory not found\n", 1))
      .mockResolvedValueOnce(commandResult(`${agentSrc}\n`));
    const backend = await createBackend();

    await expect(backend.validateWorkdir?.(workspaceSrc)).resolves.toBe(workspaceSrc);
    await expect(backend.validateWorkdir?.(`${root}/workspace/missing`)).resolves.toBeNull();
    await expect(backend.validateWorkdir?.(agentSrc)).resolves.toBe(agentSrc);

    const validationCommand = String(commandAt(1).remoteCommand);
    expect(validationCommand).toContain("openclaw-validate-workdir");
    expect(validationCommand).toContain("remote directory must stay under root");
    const agentValidationCommand = String(commandAt(3).remoteCommand);
    expect(agentValidationCommand).toContain(`${root}/agent`);
  });

  it("refreshes materialized skills before validating a skills workdir", async () => {
    const { skillsWorkspaceDir, runtimePaths, skillsWorkdir } = await skillsFixture();
    sshMocks.runSshSandboxCommand
      .mockResolvedValueOnce(commandResult("1\n"))
      .mockResolvedValueOnce(commandResult())
      .mockResolvedValueOnce(commandResult(`${skillsWorkdir}\n`));

    const backend = await createBackend({ skillsWorkspaceDir });

    await expect(backend.validateWorkdir?.(skillsWorkdir)).resolves.toBe(skillsWorkdir);
    const execSpec = await backend.buildExecSpec({
      command: "pwd",
      workdir: skillsWorkdir,
      env: {},
      usePty: false,
    });

    expect(sshMocks.uploadDirectoryToSshTarget).toHaveBeenCalledOnce();
    const skillsUploadParams = requireMockRecordArg(
      sshMocks.uploadDirectoryToSshTarget,
      0,
      "skills upload params",
    );
    expect(skillsUploadParams.localDir).toBe(skillsWorkspaceDir);
    expect(skillsUploadParams.remoteDir).toBe(runtimePaths.remoteSkillsWorkspaceDir);
    expect(requirePreparedSshInvocation().stdin).toContain(skillsWorkdir);
    await finalize(backend, execSpec);
  });

  it("discards validated materialized skills refreshes that do not launch", async () => {
    const { skillsWorkspaceDir, skillsWorkdir } = await skillsFixture();
    sshMocks.runSshSandboxCommand
      .mockResolvedValueOnce(commandResult("1\n"))
      .mockResolvedValueOnce(commandResult())
      .mockResolvedValueOnce(commandResult(`${skillsWorkdir}\n`))
      .mockResolvedValueOnce(commandResult());

    const backend = await createBackend({ skillsWorkspaceDir });

    await expect(backend.validateWorkdir?.(skillsWorkdir)).resolves.toBe(skillsWorkdir);
    backend.discardPreparedWorkdir?.(skillsWorkdir);

    const execSpec = await backend.buildExecSpec({
      ...defaultExec,
      workdir: skillsWorkdir,
    });

    expect(sshMocks.uploadDirectoryToSshTarget).toHaveBeenCalledTimes(2);
    await finalize(backend, execSpec);
  });

  it("refreshes materialized skills before each exec and remote fs command", async () => {
    const { skillsWorkspaceDir } = await skillsFixture();
    const backend = await createBackend({ skillsWorkspaceDir });

    const firstExec = await backend.buildExecSpec(defaultExec);
    const secondExec = await backend.buildExecSpec(defaultExec);
    await backend.runShellCommand({
      script: "printf ok",
    });

    expect(sshMocks.uploadDirectoryToSshTarget).toHaveBeenCalledTimes(3);
    expectUpload(0, skillsWorkspaceDir, "/workspace/.openclaw/sandbox-skills");
    await finalize(backend, firstExec);
    await finalize(backend, secondExec);
  });

  it("clears stale remote materialized skills when the local copy is missing", async () => {
    const tmpDir = tempDirs.make("openclaw-ssh-skills-");
    const skillsWorkspaceDir = path.join(tmpDir, "missing");
    const backend = await createBackend({ skillsWorkspaceDir });

    const execSpec = await backend.buildExecSpec(defaultExec);

    expect(sshMocks.uploadDirectoryToSshTarget).not.toHaveBeenCalled();
    const commandParams = commandAt(1);
    expect(commandParams.remoteCommand).toContain("openclaw-sandbox-clear");
    expect(commandParams.remoteCommand).toContain("/workspace/.openclaw/sandbox-skills");
    await finalize(backend, execSpec);
  });

  it("disposes the exec ssh session when materialized skills refresh fails", async () => {
    const { skillsWorkspaceDir } = await skillsFixture();
    const backend = await createBackend({ skillsWorkspaceDir });
    sshMocks.uploadDirectoryToSshTarget.mockRejectedValueOnce(new Error("upload failed"));

    await expect(backend.buildExecSpec(defaultExec)).rejects.toThrow("upload failed");

    expect(sshMocks.uploadDirectoryToSshTarget).toHaveBeenCalledTimes(1);
    expect(sshMocks.disposeSshSandboxSession).toHaveBeenCalledTimes(2);
  });

  it("filters blocked secrets from exec subprocess env", async () => {
    process.env.OPENAI_API_KEY = "sk-test-secret";
    process.env.LANG = "en_US.UTF-8";
    const backend = await createBackend({ agentWorkspaceDir: "/tmp/agent" });

    const execSpec = await backend.buildExecSpec(defaultExec);

    expect(execSpec.env?.OPENAI_API_KEY).toBeUndefined();
    expect(execSpec.env?.LANG).toBe("en_US.UTF-8");
  });

  it("rejects docker binds and missing ssh target", async () => {
    await expectBackendCreationToReject({
      binds: ["/tmp:/tmp:rw"],
      target: "peter@example.com:22",
      error: "does not support sandbox.docker.binds",
    });

    await expectBackendCreationToReject({
      error: "requires agents.defaults.sandbox.ssh.target",
    });
  });
});
