import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { SandboxBackendHandle } from "openclaw/plugin-sdk/sandbox";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenShellSandboxBackendFactory } from "./backend.js";
import { resolveOpenShellPluginConfig } from "./config.js";
import { createOpenShellBackendSandboxConfig } from "./openshell.test-support.js";

const sdkMocks = vi.hoisted(() => ({
  runSshSandboxCommand: vi.fn(),
  disposeSshSandboxSession: vi.fn(),
  prepareSshSandboxExec: vi.fn(),
}));

const cliMocks = vi.hoisted(() => ({
  runOpenShellCli: vi.fn(),
  createOpenShellSshSession: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/sandbox")>();
  return {
    ...actual,
    runSshSandboxCommand: sdkMocks.runSshSandboxCommand,
    disposeSshSandboxSession: sdkMocks.disposeSshSandboxSession,
    prepareSshSandboxExec: sdkMocks.prepareSshSandboxExec,
  };
});

vi.mock("./cli.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cli.js")>();
  return {
    ...actual,
    runOpenShellCli: cliMocks.runOpenShellCli,
    createOpenShellSshSession: cliMocks.createOpenShellSshSession,
  };
});

const tempWorkspaces: TempWorkspace[] = [];
const createdBackends: SandboxBackendHandle[] = [];

async function createOpenShellBackendFixture(params: {
  workspaceDir: string;
  scopeKey: string;
  command?: string;
  mode?: "mirror" | "remote";
  agentWorkspaceDir?: string;
  skillsWorkspaceDir?: string;
  workspaceAccess?: "rw" | "ro" | "none";
  remoteWorkspaceDir?: string;
  remoteAgentWorkspaceDir?: string;
}) {
  const factory = createOpenShellSandboxBackendFactory({
    pluginConfig: resolveOpenShellPluginConfig({
      command: params.command ?? "openshell",
      mode: params.mode ?? "mirror",
      remoteWorkspaceDir: params.remoteWorkspaceDir,
      remoteAgentWorkspaceDir: params.remoteAgentWorkspaceDir,
    }),
  });
  const backend = await factory({
    sessionKey: `${params.scopeKey}:turn`,
    scopeKey: params.scopeKey,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir ?? params.workspaceDir,
    skillsWorkspaceDir: params.skillsWorkspaceDir,
    cfg: {
      ...createOpenShellBackendSandboxConfig(),
      workspaceAccess: params.workspaceAccess ?? "rw",
    },
  });
  createdBackends.push(backend);
  return backend;
}

async function createWorkspace(prefix = "workspace") {
  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: `openclaw-openshell-${prefix}-`,
  });
  tempWorkspaces.push(workspace);
  return await fs.realpath(workspace.dir);
}

async function finalize(backend: SandboxBackendHandle, token: unknown) {
  await backend.finalizeExec?.({ status: "completed", exitCode: 0, timedOut: false, token });
}

async function createAdoptedRemoteBackend(params: {
  probeStdout: string;
  skillsWorkspaceDir?: string;
}) {
  const workspaceDir = await createWorkspace("remote-seed");
  await fs.writeFile(path.join(workspaceDir, "seed.txt"), "seed", "utf8");
  // A successful get adopts the sandbox left by the previous gateway process.
  sdkMocks.runSshSandboxCommand.mockImplementation(async ({ remoteCommand }) => ({
    stdout: String(remoteCommand).includes("ls -A")
      ? Buffer.from(params.probeStdout)
      : Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    code: 0,
  }));
  return await createOpenShellBackendFixture({
    workspaceDir,
    scopeKey: "agent:main",
    skillsWorkspaceDir: params.skillsWorkspaceDir,
    mode: "remote",
  });
}

function seedUploadCalls() {
  return cliMocks.runOpenShellCli.mock.calls.filter(
    ([params]) => params.args[0] === "sandbox" && params.args[1] === "upload",
  );
}

describe("openshell backend exec workdir validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cliMocks.createOpenShellSshSession.mockResolvedValue({
      command: "ssh",
      configPath: "/tmp/openclaw-openshell-test-ssh-config",
      host: "openshell-test",
    });
    cliMocks.runOpenShellCli.mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    sdkMocks.prepareSshSandboxExec.mockImplementation(
      async (params: { session: { command: string; configPath: string; host: string } }) => ({
        argv: [
          params.session.command,
          "-F",
          params.session.configPath,
          params.session.host,
          "'/bin/sh' '/tmp/openclaw-synthetic-staging/run.sh'",
        ],
        cleanup: async () => {},
      }),
    );
    sdkMocks.runSshSandboxCommand.mockImplementation(async ({ remoteCommand }) => ({
      stdout: String(remoteCommand).includes("openclaw-validate-workdir")
        ? Buffer.from("/sandbox\n")
        : Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      code: 0,
    }));
  });

  afterEach(async () => {
    for (const backend of createdBackends.splice(0)) {
      backend.discardPreparedWorkdir?.("/sandbox");
    }
    vi.unstubAllEnvs();
    await Promise.all(tempWorkspaces.splice(0).map((workspace) => workspace.cleanup()));
  });

  it("validates locally and uploads the workspace once when exec begins", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture");
    vi.stubEnv("ANTHROPIC_API_KEY", "fixture");
    vi.stubEnv("LANG", "en_US.UTF-8");
    vi.stubEnv("NODE_ENV", "test");
    const workspaceDir = await createWorkspace();
    await fs.writeFile(path.join(workspaceDir, "seed.txt"), "seed", "utf8");
    for (const protectedDirectory of [".git", "hooks", "git-hooks"]) {
      const protectedPath = path.join(workspaceDir, protectedDirectory);
      await fs.mkdir(protectedPath, { recursive: true });
      await fs.writeFile(path.join(protectedPath, "private.txt"), "host-only", "utf8");
    }
    const backend = await createOpenShellBackendFixture({
      scopeKey: "agent:somalley_alice:dashboard-8",
      workspaceDir,
    });

    await expect(backend.validateWorkdir?.("/sandbox")).resolves.toBe("/sandbox");
    expect(cliMocks.runOpenShellCli).not.toHaveBeenCalled();
    expect(cliMocks.createOpenShellSshSession).not.toHaveBeenCalled();
    const execSpec = await backend.buildExecSpec({
      command: "pwd",
      workdir: "/sandbox",
      env: {},
      usePty: false,
    });

    try {
      const uploadCalls = cliMocks.runOpenShellCli.mock.calls.filter(
        ([params]) => params.args[0] === "sandbox" && params.args[1] === "upload",
      );
      expect(uploadCalls).toHaveLength(1);
      expect(uploadCalls[0]?.[0]).toMatchObject({
        args: [
          "sandbox",
          "upload",
          "--no-git-ignore",
          backend.runtimeId,
          expect.stringMatching(/\/seed\.txt$/),
          "/sandbox/",
        ],
        cwd: workspaceDir,
      });
    } finally {
      await finalize(backend, execSpec.finalizeToken);
    }
    const nestedFile = path.join(workspaceDir, "nested", "note.txt");
    const bridge = backend.createFsBridge?.({
      sandbox: createSandboxTestContext({
        overrides: {
          backendId: "openshell",
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          containerWorkdir: backend.workdir,
          backend,
        },
      }),
    });
    if (!bridge) {
      throw new Error("Expected OpenShell mirror filesystem bridge");
    }
    await bridge.writeFile({ filePath: "nested/note.txt", data: "nested", mkdir: true });
    expect(cliMocks.runOpenShellCli).toHaveBeenLastCalledWith({
      context: expect.objectContaining({ sandboxName: backend.runtimeId }),
      args: [
        "sandbox",
        "upload",
        "--no-git-ignore",
        backend.runtimeId,
        nestedFile,
        "/sandbox/nested/note.txt",
      ],
      cwd: workspaceDir,
    });
    expect(backend.runtimeId).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    expect(backend.runtimeId).toMatch(/^oc-[a-f0-9]{16}$/u);
    expect(backend.runtimeId).toHaveLength(19);
    expect(execSpec.env.OPENAI_API_KEY).toBeUndefined();
    expect(execSpec.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(execSpec.env.LANG).toBe("en_US.UTF-8");
    expect(execSpec.env.NODE_ENV).toBe("test");
    expect(execSpec.argv).toContain("openshell-test");
  });

  it("completes concurrent validations without starting remote work or retaining a lease", async () => {
    const workspaceDir = await createWorkspace();
    const backend = await createOpenShellBackendFixture({
      workspaceDir,
      scopeKey: "agent:parallel-validation",
    });
    const completed: Array<string | null | undefined> = [];
    let cleaningUp = false;
    const validations = [0, 1].map(async () => {
      const result = await backend.validateWorkdir?.("/sandbox");
      completed.push(result);
      if (cleaningUp) {
        backend.discardPreparedWorkdir?.("/sandbox");
      }
    });
    try {
      await vi.waitFor(() => expect(completed).toEqual(["/sandbox", "/sandbox"]));
      expect(cliMocks.runOpenShellCli).not.toHaveBeenCalled();
      expect(cliMocks.createOpenShellSshSession).not.toHaveBeenCalled();
    } finally {
      cleaningUp = true;
      backend.discardPreparedWorkdir?.("/sandbox");
      await Promise.all(validations);
    }
  });

  it.each([
    { name: "filesystem root", target: "/", expected: null },
    { name: "ordinary directory", target: "/sandbox/nested", expected: "/sandbox/nested" },
    { name: "excluded directory", target: "/sandbox/.git/nested", expected: null },
    { name: "mid-path symlink", target: "/sandbox/link/nested", expected: null },
    {
      name: "agent disabled mount",
      target: "/agent/nested",
      expected: null,
      access: "none" as const,
    },
    {
      name: "generated skills ancestor",
      target: "/sandbox/.openclaw",
      expected: "/sandbox/.openclaw",
    },
    {
      name: "missing materialized child",
      target: "/sandbox/.openclaw/sandbox-skills/skills/missing",
      expected: null,
      workspaceFallback: true,
    },
    {
      name: "symlinked materialized source",
      target: "/sandbox/.openclaw/sandbox-skills/nested",
      expected: null,
      sourceLink: true,
      workspaceFallback: true,
    },
  ])("validates the uploaded host directory for $name", async (scenario) => {
    const workspaceDir = await createWorkspace();
    const agentWorkspaceDir = await createWorkspace("agent");
    const skillsWorkspaceDir = await createWorkspace("skills");
    for (const root of [workspaceDir, agentWorkspaceDir]) {
      await fs.mkdir(path.join(root, "nested"));
    }
    for (const excluded of [".git", "hooks", "git-hooks"]) {
      await fs.mkdir(path.join(workspaceDir, excluded, "nested"), { recursive: true });
    }
    await fs.symlink(workspaceDir, path.join(workspaceDir, "link"), "junction");
    await fs.mkdir(path.join(skillsWorkspaceDir, "skills", "demo"), { recursive: true });
    if (scenario.workspaceFallback) {
      await fs.mkdir(path.join(workspaceDir, path.posix.relative("/sandbox", scenario.target)), {
        recursive: true,
      });
    }
    if (scenario.sourceLink) {
      await fs.rm(skillsWorkspaceDir, { recursive: true });
      await fs.symlink(workspaceDir, skillsWorkspaceDir, "junction");
    }
    const backend = await createOpenShellBackendFixture({
      workspaceDir,
      agentWorkspaceDir,
      skillsWorkspaceDir,
      scopeKey: `agent:validation:${scenario.name}`,
      workspaceAccess: scenario.access,
    });
    await expect(backend.validateWorkdir?.(scenario.target)).resolves.toBe(scenario.expected);
    expect(cliMocks.runOpenShellCli).not.toHaveBeenCalled();
    expect(cliMocks.createOpenShellSshSession).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32")(
    "rejects a workdir omitted from the authoritative overlapping root",
    async () => {
      const workspaceDir = await createWorkspace();
      const agentWorkspaceDir = await createWorkspace("agent");
      await fs.mkdir(path.join(workspaceDir, "preserved"));
      execFileSync("mkfifo", [path.join(agentWorkspaceDir, "preserved")]);
      const backend = await createOpenShellBackendFixture({
        workspaceDir,
        agentWorkspaceDir,
        scopeKey: "agent:overlap-special-file",
        remoteWorkspaceDir: "/sandbox",
        remoteAgentWorkspaceDir: "/sandbox",
      });

      await expect(backend.validateWorkdir?.("/sandbox/preserved")).resolves.toBeNull();
    },
  );

  it.each([
    {
      workspace: "/sandbox/primary",
      agent: "/sandbox",
      uploads: [
        ["agent-only", "/sandbox/"],
        ["host-only", "/sandbox/primary/"],
      ],
    },
    {
      workspace: "/sandbox",
      agent: "/sandbox",
      uploads: [
        ["host-only", "/sandbox/"],
        ["agent-only", "/sandbox/"],
      ],
    },
    {
      workspace: "/sandbox",
      agent: "/sandbox/hooks",
      uploads: [
        ["host-only", "/sandbox/"],
        ["agent-only", "/sandbox/hooks/"],
      ],
    },
  ])(
    "clears each overlapping root immediately before upload: $workspace -> $agent",
    async (scenario) => {
      const workspaceDir = await createWorkspace();
      const agentWorkspaceDir = await createWorkspace("agent");
      await fs.mkdir(path.join(workspaceDir, "host-only"));
      await fs.mkdir(path.join(agentWorkspaceDir, "agent-only"));
      const backend = await createOpenShellBackendFixture({
        workspaceDir,
        agentWorkspaceDir,
        scopeKey: `agent:overlap-publication:${scenario.workspace}:${scenario.agent}`,
        remoteWorkspaceDir: scenario.workspace,
        remoteAgentWorkspaceDir: scenario.agent,
      });

      const exec = await backend.buildExecSpec({ command: "true", env: {}, usePty: false });
      try {
        const clearCallOrders = sdkMocks.runSshSandboxCommand.mock.calls.flatMap(
          ([params], index) =>
            String(params.remoteCommand).includes("find")
              ? [sdkMocks.runSshSandboxCommand.mock.invocationCallOrder[index]!]
              : [],
        );
        const uploadCalls = cliMocks.runOpenShellCli.mock.calls.flatMap(([params], index) =>
          params.args[0] === "sandbox" && params.args[1] === "upload"
            ? [{ params, order: cliMocks.runOpenShellCli.mock.invocationCallOrder[index]! }]
            : [],
        );
        expect(clearCallOrders).toHaveLength(2);
        expect(
          [
            ...clearCallOrders.map((order) => ({ label: "clear", order })),
            ...uploadCalls.map(({ order }) => ({ label: "upload", order })),
          ]
            .toSorted((a, b) => a.order - b.order)
            .map(({ label }) => label),
        ).toEqual(["clear", "upload", "clear", "upload"]);
        expect(
          uploadCalls.map(({ params }) => [
            path.basename(params.args.at(-2) ?? ""),
            params.args.at(-1),
          ]),
        ).toEqual(scenario.uploads);
      } finally {
        await finalize(backend, exec.finalizeToken);
      }
    },
  );

  it("downloads the primary root without reconciling the writable containing agent root", async () => {
    const workspaceAccess = "rw";
    const remoteWorkspaceDir = "/sandbox/agent/project";
    const remoteAgentWorkspaceDir = "/sandbox/agent";
    const workspaceDir = await createWorkspace();
    const agentWorkspaceDir = await createWorkspace("agent");
    await fs.writeFile(path.join(workspaceDir, "primary-only"), "local-primary");
    await fs.writeFile(path.join(agentWorkspaceDir, "agent-only"), "local-agent");
    await fs.mkdir(path.join(agentWorkspaceDir, "project"));
    await fs.writeFile(
      path.join(agentWorkspaceDir, "project", "agent-shadow.txt"),
      "preserved-shadow",
    );
    cliMocks.runOpenShellCli.mockImplementation(async ({ args }) => {
      if (args[1] === "download") {
        const remote = args.at(-2);
        const target = args.at(-1);
        if (!target) {
          throw new Error("Expected download target");
        }
        await fs.writeFile(
          path.join(target, remote === remoteWorkspaceDir ? "primary-only" : "agent-only"),
          remote === remoteWorkspaceDir ? "remote-primary" : "remote-agent",
        );
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const backend = await createOpenShellBackendFixture({
      workspaceDir,
      agentWorkspaceDir,
      scopeKey: "agent:overlap-download",
      workspaceAccess,
      remoteWorkspaceDir,
      remoteAgentWorkspaceDir,
    });

    const exec = await backend.buildExecSpec({ command: "true", env: {}, usePty: false });
    await finalize(backend, exec.finalizeToken);

    await expect(fs.readFile(path.join(agentWorkspaceDir, "agent-only"), "utf8")).resolves.toBe(
      "local-agent",
    );
    await expect(fs.readFile(path.join(workspaceDir, "primary-only"), "utf8")).resolves.toBe(
      "remote-primary",
    );
    await expect(
      fs.readFile(path.join(agentWorkspaceDir, "project", "agent-shadow.txt"), "utf8"),
    ).resolves.toBe("preserved-shadow");
    expect(
      cliMocks.runOpenShellCli.mock.calls.flatMap(([params]) =>
        params.args[1] === "download" ? [params.args.at(-2)] : [],
      ),
    ).toEqual([remoteWorkspaceDir]);
  });

  it("rejects an aborted file write after waiting for mirror publication", async () => {
    const workspaceDir = await createWorkspace();
    const backend = await createOpenShellBackendFixture({
      workspaceDir,
      scopeKey: "agent:aborted-write",
    });
    const bridge = expectDefined(
      backend.createFsBridge?.({
        sandbox: createSandboxTestContext({
          overrides: {
            workspaceDir,
            agentWorkspaceDir: workspaceDir,
            containerWorkdir: backend.workdir,
            backend,
          },
        }),
      }),
      "mirror bridge",
    );
    const readDirectory = expectDefined(bridge.readDirectory?.bind(bridge), "directory reader");
    const exec = await backend.buildExecSpec({ command: "true", env: {}, usePty: false });
    const controller = new AbortController();
    const pending = bridge.writeFile({
      filePath: "cancelled.txt",
      data: "cancelled",
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toThrow("cancelled while queued");
    controller.abort(new Error("cancelled while queued"));
    await finalize(backend, exec.finalizeToken);
    await rejected;
    await expect(fs.stat(path.join(workspaceDir, "cancelled.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await bridge.writeFile({ filePath: "next.txt", data: "next" });
    await expect(fs.readFile(path.join(workspaceDir, "next.txt"), "utf8")).resolves.toBe("next");
    await expect(readDirectory({ filePath: "." })).resolves.toEqual([
      { name: "next.txt", isDirectory: false },
    ]);
  });

  it.each([
    {
      label: "legacy trailing exec",
      help: "Usage: openshell sandbox create [OPTIONS]\n      --no-tty\n",
      expectedEnding: ["--", "true"],
    },
    {
      label: "persistent canonical main",
      help: "Usage: openshell sandbox create [OPTIONS]\n      --detach  Start without attaching\n",
      expectedEnding: ["--detach", "--", "sleep", "infinity"],
    },
  ])("creates compatible persistent sandboxes for $label CLIs", async (scenario) => {
    const workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-openshell-create-",
    });
    tempWorkspaces.push(workspace);
    cliMocks.runOpenShellCli.mockImplementation(async ({ args }: { args: string[] }) => {
      if (args[1] === "get") {
        return { code: 1, stdout: "", stderr: "sandbox not found" };
      }
      if (args[1] === "create" && args[2] === "--help") {
        return { code: 0, stdout: scenario.help, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    for (const scopeKey of ["agent:create:first", "agent:create:second"]) {
      const backend = await createOpenShellBackendFixture({
        workspaceDir: workspace.dir,
        scopeKey,
        command: `openshell-${scenario.label.replaceAll(" ", "-")}`,
      });
      const execSpec = await backend.buildExecSpec({ command: "pwd", env: {}, usePty: false });
      await backend.finalizeExec?.({
        status: "completed",
        exitCode: 0,
        timedOut: false,
        token: execSpec.finalizeToken,
      });
    }

    const helpCalls = cliMocks.runOpenShellCli.mock.calls.filter(
      ([params]) => params.args[1] === "create" && params.args[2] === "--help",
    );
    expect(helpCalls).toHaveLength(1);
    const createCalls = cliMocks.runOpenShellCli.mock.calls.filter(
      ([params]) => params.args[1] === "create" && params.args[2] !== "--help",
    );
    expect(createCalls).toHaveLength(2);
    for (const [params] of createCalls) {
      expect(params.args.slice(-scenario.expectedEnding.length)).toEqual(scenario.expectedEnding);
    }
  });

  it.each([
    { label: "a symlink-aliased host workspace", host: "alias", sharedRuntime: false },
    { label: "a remote runtime", host: "different", sharedRuntime: true },
  ])("holds $label until command execution and publication finish", async (scenario) => {
    const workspaces = await Promise.all(
      ["first", "second"].map(async (label) =>
        tempWorkspace({
          rootDir: resolvePreferredOpenClawTmpDir(),
          prefix: `openclaw-openshell-${label}-`,
        }),
      ),
    );
    tempWorkspaces.push(...workspaces);
    const firstWorkspace = expectDefined(workspaces[0], "first OpenShell workspace");
    const secondWorkspace = expectDefined(workspaces[1], "second OpenShell workspace");
    const secondWorkspaceDir =
      scenario.host === "alias" ? path.join(secondWorkspace.dir, "alias") : secondWorkspace.dir;
    if (scenario.host === "alias") {
      await fs.symlink(firstWorkspace.dir, secondWorkspaceDir, "junction");
    }
    const first = await createOpenShellBackendFixture({
      workspaceDir: firstWorkspace.dir,
      scopeKey: "agent:workspace:first",
    });
    const second = await createOpenShellBackendFixture({
      workspaceDir: secondWorkspaceDir,
      scopeKey: scenario.sharedRuntime ? "agent:workspace:first" : "agent:workspace:second",
    });

    const firstExec = await first.buildExecSpec({ command: "first", env: {}, usePty: false });
    const secondPreparation = second.buildExecSpec({ command: "second", env: {}, usePty: false });
    // Observe rejection while the first lease is held; cleanup still awaits and rethrows it.
    const secondSettled = Promise.allSettled([secondPreparation]);
    try {
      try {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(cliMocks.runOpenShellCli.mock.calls.map(([params]) => params.args[1])).toEqual([
          "get",
        ]);
      } finally {
        await finalize(first, firstExec.finalizeToken);
      }
      await secondPreparation;
      expect(cliMocks.runOpenShellCli.mock.calls.map(([params]) => params.args[1])).toEqual([
        "get",
        "download",
        "get",
      ]);
    } finally {
      await secondSettled;
      const secondExec = await secondPreparation;
      await finalize(second, secondExec.finalizeToken);
    }
  });

  it.each(["exec preparation", "mirror publication", "SSH cleanup"])(
    "releases workspace ownership after failed %s",
    async (failure) => {
      const workspaceDir = await createWorkspace("failure");
      const scopeKey = `agent:failed:${failure}`;
      const first = await createOpenShellBackendFixture({ workspaceDir, scopeKey });
      const second = await createOpenShellBackendFixture({ workspaceDir, scopeKey });
      if (failure === "exec preparation") {
        sdkMocks.prepareSshSandboxExec.mockRejectedValueOnce(new Error("prepare failed"));
        await expect(
          first.buildExecSpec({ command: "first", env: {}, usePty: false }),
        ).rejects.toThrow("prepare failed");
      } else {
        if (failure === "SSH cleanup") {
          sdkMocks.prepareSshSandboxExec.mockResolvedValueOnce({
            argv: ["ssh", "openshell-test"],
            cleanup: async () => {
              throw new Error("cleanup failed");
            },
          });
        }
        const firstExec = await first.buildExecSpec({ command: "first", env: {}, usePty: false });
        if (failure === "mirror publication") {
          cliMocks.runOpenShellCli.mockResolvedValueOnce({
            code: 1,
            stdout: "",
            stderr: "download failed",
          });
        }
        await expect(finalize(first, firstExec.finalizeToken)).rejects.toThrow(
          failure === "SSH cleanup" ? "cleanup failed" : "download failed",
        );
      }
      const secondExec = await second.buildExecSpec({ command: "second", env: {}, usePty: false });
      await finalize(second, secondExec.finalizeToken);
    },
  );

  it("keeps operations against different workspaces parallel", async () => {
    const workspaces = await Promise.all(
      ["first", "second"].map(async (label) =>
        tempWorkspace({
          rootDir: resolvePreferredOpenClawTmpDir(),
          prefix: `openclaw-openshell-${label}-`,
        }),
      ),
    );
    tempWorkspaces.push(...workspaces);
    const backends = await Promise.all(
      workspaces.map(async (workspace, index) =>
        createOpenShellBackendFixture({
          workspaceDir: workspace.dir,
          scopeKey: `agent:workspace:${index}`,
        }),
      ),
    );
    const first = expectDefined(backends[0], "first OpenShell backend");
    const second = expectDefined(backends[1], "second OpenShell backend");
    const firstExec = await first.buildExecSpec({ command: "first", env: {}, usePty: false });
    const secondPreparation = second.buildExecSpec({ command: "second", env: {}, usePty: false });
    try {
      await secondPreparation;
      const startedRuntimeIds = cliMocks.runOpenShellCli.mock.calls
        .filter(([params]) => params.args[1] === "get")
        .map(([params]) => params.args[2]);
      expect(startedRuntimeIds).toEqual([first.runtimeId, second.runtimeId]);
    } finally {
      try {
        await finalize(first, firstExec.finalizeToken);
      } finally {
        const secondExec = await secondPreparation;
        await finalize(second, secondExec.finalizeToken);
      }
    }
  });

  describe("remote-mode seed across gateway restart", () => {
    it.each(["same handle", "another handle"])(
      "starts remote operations on %s while an earlier command is still running",
      async (handleKind) => {
        const first = await createAdoptedRemoteBackend({ probeStdout: "1\n" });
        const second =
          handleKind === "same handle"
            ? first
            : await createAdoptedRemoteBackend({ probeStdout: "1\n" });
        const firstExec = await first.buildExecSpec({
          command: "wait-for-file",
          env: {},
          usePty: false,
        });
        const secondPreparation = second.buildExecSpec({
          command: "write-file",
          env: {},
          usePty: false,
        });
        try {
          await secondPreparation;
          expect(seedUploadCalls()).toHaveLength(0);
          expect(
            sdkMocks.runSshSandboxCommand.mock.calls.filter(([params]) =>
              String(params.remoteCommand).includes("rm -rf"),
            ),
          ).toHaveLength(0);
        } finally {
          try {
            await finalize(first, firstExec.finalizeToken);
          } finally {
            const prepared = await secondPreparation;
            await finalize(second, prepared.finalizeToken);
          }
        }
      },
    );

    it("refreshes materialized skills once per handle, not between remote operations", async () => {
      const skillsWorkspace = await tempWorkspace({
        rootDir: resolvePreferredOpenClawTmpDir(),
        prefix: "openclaw-openshell-remote-skills-",
      });
      tempWorkspaces.push(skillsWorkspace);
      await fs.mkdir(path.join(skillsWorkspace.dir, "skills", "demo"), { recursive: true });
      await fs.writeFile(path.join(skillsWorkspace.dir, "skills", "demo", "SKILL.md"), "# Demo\n");
      const backend = await createAdoptedRemoteBackend({
        probeStdout: "1\n",
        skillsWorkspaceDir: skillsWorkspace.dir,
      });
      const firstExec = await backend.buildExecSpec({ command: "first", env: {}, usePty: false });
      await finalize(backend, firstExec.finalizeToken);
      const initialUploads = seedUploadCalls().length;
      expect(initialUploads).toBeGreaterThan(0);
      const initialClears = sdkMocks.runSshSandboxCommand.mock.calls.filter(([params]) =>
        String(params.remoteCommand).includes("rm -rf"),
      ).length;
      expect(initialClears).toBeGreaterThan(0);
      await backend.runShellCommand?.({ script: "printf file-operation", args: [] });
      const secondExec = await backend.buildExecSpec({ command: "second", env: {}, usePty: false });
      try {
        expect(seedUploadCalls()).toHaveLength(initialUploads);
        expect(
          sdkMocks.runSshSandboxCommand.mock.calls.filter(([params]) =>
            String(params.remoteCommand).includes("rm -rf"),
          ),
        ).toHaveLength(initialClears);
      } finally {
        await finalize(backend, secondExec.finalizeToken);
      }
    });

    it("serializes initial seed publication across handles without serializing later commands", async () => {
      const first = await createAdoptedRemoteBackend({ probeStdout: "0\n" });
      const second = await createAdoptedRemoteBackend({ probeStdout: "1\n" });
      const seedStarted = createDeferred<void>();
      const releaseSeed = createDeferred<void>();
      let seeded = false;
      sdkMocks.runSshSandboxCommand.mockImplementation(async ({ remoteCommand }) => ({
        stdout: String(remoteCommand).includes("ls -A")
          ? Buffer.from(seeded ? "1\n" : "0\n")
          : Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        code: 0,
      }));
      cliMocks.runOpenShellCli.mockImplementation(async ({ args }: { args: string[] }) => {
        if (args[1] === "upload") {
          seedStarted.resolve();
          await releaseSeed.promise;
          seeded = true;
        }
        return { code: 0, stdout: "", stderr: "" };
      });
      const firstPreparation = first.buildExecSpec({ command: "first", env: {}, usePty: false });
      let secondPreparation: typeof firstPreparation | undefined;
      let preparationsSettled: Promise<PromiseSettledResult<Awaited<typeof firstPreparation>>[]> =
        Promise.allSettled([firstPreparation]);
      try {
        await Promise.race([seedStarted.promise, firstPreparation]);
        let secondStarted = false;
        secondPreparation = second
          .buildExecSpec({ command: "second", env: {}, usePty: false })
          .then((prepared) => {
            secondStarted = true;
            return prepared;
          });
        preparationsSettled = Promise.allSettled([firstPreparation, secondPreparation]);
        try {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(
            cliMocks.runOpenShellCli.mock.calls.filter(([params]) => params.args[1] === "get"),
          ).toHaveLength(1);
          expect(secondStarted).toBe(false);
        } finally {
          releaseSeed.resolve();
        }
        await firstPreparation;
        await secondPreparation;
        const uploads = seedUploadCalls();
        expect(uploads).toHaveLength(1);
        expect(uploads[0]?.[0]).toMatchObject({
          args: expect.arrayContaining([expect.stringMatching(/\/seed\.txt$/), "/sandbox/"]),
        });
      } finally {
        // An assertion or preparation failure must not leave work using a deleted workspace.
        releaseSeed.resolve();
        try {
          const firstExec = await firstPreparation;
          await finalize(first, firstExec.finalizeToken);
        } finally {
          await preparationsSettled;
          const secondExec = await secondPreparation;
          if (secondExec) {
            await finalize(second, secondExec.finalizeToken);
          }
        }
      }
    });
  });
});
