import { describe, expect, it } from "vitest";
import {
  buildSmolExecArgv,
  createSmolSandboxBackendFactory,
  createSmolSandboxBackendManager,
  resolveSmolMachineName,
  resolveSmolMounts,
  resolveSmolSandboxWorkdir,
} from "./backend.js";
import type { SmolCommandRunner } from "./cli.js";
import { resolveSmolPluginConfig } from "./config.js";
import {
  createSmolBackendSandboxConfig,
  createSmolRuntimeEntryFixture,
} from "./smol.test-support.js";

const pluginConfig = resolveSmolPluginConfig(undefined);

function createRecordingRunner(
  respond: (argv: string[]) => { code: number; stdout: string; stderr: string },
) {
  const calls: string[][] = [];
  const run: SmolCommandRunner = async (argv) => {
    calls.push(argv);
    return respond(argv);
  };
  return { calls, run };
}

describe("smol machine naming", () => {
  it("derives one stable machine per scope", () => {
    const name = resolveSmolMachineName({ scopeKey: "agent:main:main" });
    expect(name).toMatch(/^openclaw-smol-[0-9a-f]{16}$/);
    expect(resolveSmolMachineName({ scopeKey: "agent:main:main" })).toBe(name);
    expect(resolveSmolMachineName({ scopeKey: "agent:other:main" })).not.toBe(name);
    expect(resolveSmolMachineName({ scopeKey: "   " })).toBe(
      resolveSmolMachineName({ scopeKey: "session" }),
    );
  });

  it("adopts the registered machine for the scope", () => {
    const name = resolveSmolMachineName({ scopeKey: "agent:main:main" });
    expect(
      resolveSmolMachineName({
        scopeKey: "agent:main:main",
        registeredRuntimeIds: ["openclaw-smol-unrelated", name],
      }),
    ).toBe(name);
  });
});

describe("smol sandbox workdir", () => {
  it("prefers the plugin workdir over the Docker-shaped sandbox workdir", () => {
    const cfg = createSmolBackendSandboxConfig({ workdir: "/workspace" });
    expect(resolveSmolSandboxWorkdir(pluginConfig, { cfg })).toBe("/workspace");
    expect(resolveSmolSandboxWorkdir(resolveSmolPluginConfig({ workdir: "/work" }), { cfg })).toBe(
      "/work",
    );
  });
});

describe("smol mounts", () => {
  const base = {
    workspaceDir: "/tmp/openclaw-smol-test/workspace",
    agentWorkspaceDir: "/tmp/openclaw-smol-test/agent",
    skillsWorkspaceDir: "/tmp/openclaw-smol-test/does-not-exist",
  };

  it("mounts the workspace read-write and the agent workspace beside it", () => {
    expect(
      resolveSmolMounts({ ...base, cfg: createSmolBackendSandboxConfig() }, "/workspace"),
    ).toEqual([
      { hostPath: base.workspaceDir, guestPath: "/workspace", readOnly: false },
      { hostPath: base.agentWorkspaceDir, guestPath: "/agent", readOnly: false },
    ]);
  });

  it("mounts both workspaces read-only under ro access", () => {
    expect(
      resolveSmolMounts({ ...base, cfg: createSmolBackendSandboxConfig({}, "ro") }, "/workspace"),
    ).toEqual([
      { hostPath: base.workspaceDir, guestPath: "/workspace", readOnly: true },
      { hostPath: base.agentWorkspaceDir, guestPath: "/agent", readOnly: true },
    ]);
  });

  it("keeps a private workspace private and skips a duplicate agent mount", () => {
    expect(
      resolveSmolMounts({ ...base, cfg: createSmolBackendSandboxConfig({}, "none") }, "/workspace"),
    ).toEqual([{ hostPath: base.workspaceDir, guestPath: "/workspace", readOnly: false }]);
    expect(
      resolveSmolMounts(
        { ...base, agentWorkspaceDir: base.workspaceDir, cfg: createSmolBackendSandboxConfig() },
        "/workspace",
      ),
    ).toEqual([{ hostPath: base.workspaceDir, guestPath: "/workspace", readOnly: false }]);
  });

  it("projects core resource mounts read-only and lets the last mount at a path win", () => {
    expect(
      resolveSmolMounts(
        {
          ...base,
          cfg: createSmolBackendSandboxConfig(),
          readOnlyResourceMounts: [
            { hostPath: "/srv/instructions", containerPath: "/workspace/.openclaw/instructions/" },
            { hostPath: "/srv/agent-override", containerPath: "/agent" },
          ],
        },
        "/workspace",
      ),
    ).toEqual([
      { hostPath: base.workspaceDir, guestPath: "/workspace", readOnly: false },
      { hostPath: "/srv/agent-override", guestPath: "/agent", readOnly: true },
      {
        hostPath: "/srv/instructions",
        guestPath: "/workspace/.openclaw/instructions/",
        readOnly: true,
      },
    ]);
  });
});

describe("smol exec argv", () => {
  it("runs guest commands through the local machine's shell", () => {
    expect(
      buildSmolExecArgv({
        config: pluginConfig,
        machineName: "openclaw-smol-1",
        remoteCommand: "'/bin/sh' '-c' 'echo hi'",
      }),
    ).toEqual([
      "smol",
      "machine",
      "exec",
      "--name",
      "openclaw-smol-1",
      "--local",
      "-i",
      "--",
      "/bin/sh",
      "-c",
      "'/bin/sh' '-c' 'echo hi'",
    ]);
    expect(
      buildSmolExecArgv({
        config: pluginConfig,
        machineName: "openclaw-smol-1",
        remoteCommand: "x",
        tty: true,
      }),
    ).toContain("-t");
  });
});

describe("smol sandbox backend factory", () => {
  const createParams = {
    sessionKey: "agent:main:main",
    scopeKey: "agent:main:main",
    workspaceDir: "/tmp/openclaw-smol-test/workspace",
    agentWorkspaceDir: "/tmp/openclaw-smol-test/workspace",
  };

  it("describes the machine handle without touching the engine", async () => {
    const { calls, run } = createRecordingRunner(() => ({ code: 0, stdout: "[]", stderr: "" }));
    const handle = await createSmolSandboxBackendFactory({ pluginConfig, run })({
      ...createParams,
      cfg: createSmolBackendSandboxConfig({ env: { FOO: "bar" } }),
    });
    expect(handle).toMatchObject({
      id: "smol",
      runtimeId: resolveSmolMachineName(createParams),
      runtimeLabel: resolveSmolMachineName(createParams),
      workdir: "/workspace",
      env: { FOO: "bar" },
      configLabel: "python:3.12-slim",
      configLabelKind: "Image",
      capabilities: { readOnlyResourceMounts: true },
    });
    expect(handle.createFsBridge).toBeUndefined();
    expect(handle.prepareProcessCleanup).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("refuses sandbox.docker.binds instead of mounting unvalidated host paths", async () => {
    await expect(
      createSmolSandboxBackendFactory({ pluginConfig })({
        ...createParams,
        cfg: createSmolBackendSandboxConfig({ binds: ["/etc:/host-etc:ro"] }),
      }),
    ).rejects.toThrow("smol sandbox backend does not support sandbox.docker.binds");
  });
});

describe("smol sandbox backend manager", () => {
  const entry = createSmolRuntimeEntryFixture("openclaw-smol-1");

  it("reports the machine state and image from the local inventory", async () => {
    const { calls, run } = createRecordingRunner(() => ({
      code: 0,
      stdout: JSON.stringify([
        { name: "openclaw-smol-1", state: "running", source: "python:3.12-slim@sha256:abc" },
      ]),
      stderr: "",
    }));
    const manager = createSmolSandboxBackendManager({ pluginConfig, run });
    await expect(manager.describeRuntime({ entry, config: {} })).resolves.toEqual({
      running: true,
      actualConfigLabel: "python:3.12-slim@sha256:abc",
      configLabelMatch: true,
    });
    expect(calls).toEqual([["smol", "machine", "ls", "--json", "--local"]]);
  });

  it("flags a machine whose image no longer matches the configured plugin image", async () => {
    const { run } = createRecordingRunner(() => ({
      code: 0,
      stdout: JSON.stringify([{ name: "openclaw-smol-1", state: "stopped", source: "debian:12" }]),
      stderr: "",
    }));
    const manager = createSmolSandboxBackendManager({ pluginConfig, run });
    await expect(
      manager.describeRuntime({
        entry,
        config: { plugins: { entries: { smol: { config: { image: "debian:13" } } } } },
      }),
    ).resolves.toEqual({
      running: false,
      actualConfigLabel: "debian:12",
      configLabelMatch: false,
    });
  });

  it("falls back to the registry image when the machine is gone", async () => {
    const { run } = createRecordingRunner(() => ({ code: 0, stdout: "[]", stderr: "" }));
    const manager = createSmolSandboxBackendManager({ pluginConfig, run });
    await expect(manager.describeRuntime({ entry, config: {} })).resolves.toEqual({
      running: false,
      actualConfigLabel: "python:3.12-slim",
      configLabelMatch: true,
    });
  });

  it("removes an existing machine and treats a missing one as already removed", async () => {
    let present = true;
    const { calls, run } = createRecordingRunner((argv) => {
      if (argv[2] === "ls") {
        return {
          code: 0,
          stdout: JSON.stringify(present ? [{ name: "openclaw-smol-1", state: "running" }] : []),
          stderr: "",
        };
      }
      present = false;
      return { code: 0, stdout: "", stderr: "" };
    });
    const manager = createSmolSandboxBackendManager({ pluginConfig, run });
    await manager.removeRuntime({ entry, config: {} });
    await manager.removeRuntime({ entry, config: {} });
    expect(calls).toEqual([
      ["smol", "machine", "ls", "--json", "--local"],
      ["smol", "machine", "rm", "--name", "openclaw-smol-1", "--force", "--local"],
      ["smol", "machine", "ls", "--json", "--local"],
    ]);
  });

  it("surfaces a failed removal", async () => {
    const { run } = createRecordingRunner((argv) =>
      argv[2] === "ls"
        ? {
            code: 0,
            stdout: JSON.stringify([{ name: "openclaw-smol-1", state: "running" }]),
            stderr: "",
          }
        : { code: 1, stdout: "", stderr: "machine is branched; stop its branches first" },
    );
    const manager = createSmolSandboxBackendManager({ pluginConfig, run });
    await expect(manager.removeRuntime({ entry, config: {} })).rejects.toThrow(
      "smol machine rm failed: machine is branched; stop its branches first",
    );
  });
});
