import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeSandboxConfigHash } from "./config-hash.js";
import { collectDockerFlagValues } from "./test-args.js";
import type { SandboxConfig } from "./types.js";
import { SANDBOX_MOUNT_FORMAT_VERSION } from "./workspace-mounts.js";

type SpawnCall = {
  command: string;
  args: string[];
};

type ScriptedDockerResult = {
  prefix: string[];
  code: number;
  stdout?: string;
  stderr?: string;
};

type MockDockerChild = EventEmitter & {
  stdout: Readable;
  stderr: Readable;
  stdin: { end: (input?: string | Buffer) => void };
  kill: (signal?: NodeJS.Signals) => void;
};

const spawnState = vi.hoisted(() => ({
  calls: [] as SpawnCall[],
  containerExists: true,
  inspectRunning: true,
  labelHash: "",
  scriptedResults: [] as ScriptedDockerResult[],
}));

const registryMocks = vi.hoisted(() => ({
  readRegistryEntry: vi.fn(),
  updateRegistry: vi.fn(),
}));

vi.mock("./registry.js", () => ({
  readRegistryEntry: registryMocks.readRegistryEntry,
  updateRegistry: registryMocks.updateRegistry,
}));

function createMockDockerChild(): MockDockerChild {
  const child = new EventEmitter() as MockDockerChild;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = { end: () => undefined };
  child.kill = () => undefined;
  return child;
}

function normalizeMockCommand(command: string): string {
  return /(?:^|[\\/])docker(?:\.exe)?$/i.test(command) ? "docker" : command;
}

function spawnDockerProcess(command: string, args: string[]) {
  const normalizedCommand = normalizeMockCommand(command);
  spawnState.calls.push({ command: normalizedCommand, args });
  const child = createMockDockerChild();

  let code = 0;
  let stdout = "";
  let stderr = "";
  const scriptedIndex =
    normalizedCommand === "docker"
      ? spawnState.scriptedResults.findIndex((result) =>
          result.prefix.every((part, index) => args[index] === part),
        )
      : -1;
  if (scriptedIndex >= 0) {
    const [result] = spawnState.scriptedResults.splice(scriptedIndex, 1);
    code = result?.code ?? 0;
    stdout = result?.stdout ?? "";
    stderr = result?.stderr ?? "";
  } else if (normalizedCommand !== "docker") {
    code = 1;
    stderr = `unexpected command: ${command}`;
  } else if (args[0] === "inspect" && args[1] === "-f" && args[2] === "{{.State.Running}}") {
    if (!spawnState.containerExists) {
      code = 1;
      stderr = "No such container";
    } else {
      stdout = spawnState.inspectRunning ? "true\n" : "false\n";
    }
  } else if (
    args[0] === "inspect" &&
    args[1] === "-f" &&
    args[2]?.includes('index .Config.Labels "openclaw.configHash"')
  ) {
    stdout = `${spawnState.labelHash}\n`;
  } else if (
    (args[0] === "rm" && args[1] === "-f") ||
    (args[0] === "image" && args[1] === "inspect") ||
    args[0] === "create" ||
    args[0] === "start"
  ) {
    code = 0;
  } else {
    code = 1;
    stderr = `unexpected docker args: ${args.join(" ")}`;
  }

  queueMicrotask(() => {
    if (stdout) {
      child.stdout.emit("data", Buffer.from(stdout));
    }
    if (stderr) {
      child.stderr.emit("data", Buffer.from(stderr));
    }
    child.emit("close", code);
  });
  return child;
}

async function createChildProcessMock() {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnDockerProcess,
  };
}

vi.mock("node:child_process", async () => createChildProcessMock());

let ensureSandboxContainer: typeof import("./docker.js").ensureSandboxContainer;

async function loadFreshDockerModuleForTest() {
  vi.resetModules();
  vi.doMock("./registry.js", () => ({
    readRegistryEntry: registryMocks.readRegistryEntry,
    updateRegistry: registryMocks.updateRegistry,
  }));
  vi.doMock("node:child_process", async () => createChildProcessMock());
  ({ ensureSandboxContainer } = await import("./docker.js"));
}

function queueDockerResult(prefix: string[], result: Omit<ScriptedDockerResult, "prefix">) {
  spawnState.scriptedResults.push({ prefix, ...result });
}

function createSandboxConfig(
  dns: string[],
  binds?: string[],
  workspaceAccess: "rw" | "ro" | "none" = "rw",
): SandboxConfig {
  return {
    mode: "all",
    backend: "docker",
    scope: "shared",
    workspaceAccess,
    workspaceRoot: "~/.openclaw/sandboxes",
    docker: {
      image: "openclaw-sandbox:test",
      containerPrefix: "oc-test-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: ["/tmp", "/var/tmp", "/run"],
      network: "none",
      capDrop: ["ALL"],
      env: { LANG: "C.UTF-8" },
      dns,
      extraHosts: ["host.docker.internal:host-gateway"],
      binds: binds ?? ["/tmp/workspace:/workspace:rw"],
      dangerouslyAllowReservedContainerTargets: true,
    },
    ssh: {
      command: "ssh",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      strictHostKeyChecking: true,
      updateHostKeys: true,
    },
    browser: {
      enabled: false,
      image: "openclaw-browser:test",
      containerPrefix: "oc-browser-",
      network: "openclaw-sandbox-browser",
      cdpPort: 9222,
      vncPort: 5900,
      noVncPort: 6080,
      headless: true,
      enableNoVnc: false,
      allowHostControl: false,
      autoStart: false,
      autoStartTimeoutMs: 5000,
    },
    tools: { allow: [], deny: [] },
    prune: { idleHours: 24, maxAgeDays: 7 },
  };
}

async function ensureSandboxCreateCallForTest(params: {
  cfg: SandboxConfig;
  workspaceDir?: string;
  sessionKey?: string;
}): Promise<SpawnCall> {
  const workspaceDir = params.workspaceDir ?? "/tmp/workspace";
  await ensureSandboxContainer({
    sessionKey: params.sessionKey ?? "agent:main:session-1",
    workspaceDir,
    agentWorkspaceDir: workspaceDir,
    cfg: params.cfg,
  });

  const createCall = spawnState.calls.find(
    (call) => call.command === "docker" && call.args[0] === "create",
  );
  if (!createCall) {
    throw new Error("expected docker create call");
  }
  return createCall;
}

describe("ensureSandboxContainer config-hash recreation", () => {
  beforeEach(async () => {
    spawnState.calls.length = 0;
    spawnState.containerExists = true;
    spawnState.inspectRunning = true;
    spawnState.labelHash = "";
    spawnState.scriptedResults.length = 0;
    registryMocks.readRegistryEntry.mockClear();
    registryMocks.updateRegistry.mockClear();
    registryMocks.updateRegistry.mockResolvedValue(undefined);
    await loadFreshDockerModuleForTest();
  });

  it("recreates shared container when array-order change alters hash", async () => {
    const workspaceDir = "/tmp/workspace";
    const oldCfg = createSandboxConfig(["1.1.1.1", "8.8.8.8"]);
    const newCfg = createSandboxConfig(["8.8.8.8", "1.1.1.1"]);

    const oldHash = computeSandboxConfigHash({
      docker: oldCfg.docker,
      workspaceAccess: oldCfg.workspaceAccess,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
    });
    const newHash = computeSandboxConfigHash({
      docker: newCfg.docker,
      workspaceAccess: newCfg.workspaceAccess,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
    });
    expect(newHash).not.toBe(oldHash);

    spawnState.labelHash = oldHash;
    registryMocks.readRegistryEntry.mockResolvedValue({
      containerName: "oc-test-shared",
      sessionKey: "shared",
      createdAtMs: 1,
      lastUsedAtMs: 0,
      image: newCfg.docker.image,
      configHash: oldHash,
    });

    const containerName = await ensureSandboxContainer({
      sessionKey: "agent:main:session-1",
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      cfg: newCfg,
    });

    expect(containerName).toBe("oc-test-shared");
    const dockerCalls = spawnState.calls.filter((call) => call.command === "docker");
    expect(
      dockerCalls.some(
        (call) =>
          call.args[0] === "rm" && call.args[1] === "-f" && call.args[2] === "oc-test-shared",
      ),
    ).toBe(true);
    const createCall = dockerCalls.find((call) => call.args[0] === "create");
    if (!createCall) {
      throw new Error("expected recreated docker create call");
    }
    expect(createCall.args).toContain(`openclaw.configHash=${newHash}`);
    const registryUpdate = registryMocks.updateRegistry.mock.calls.at(-1)?.[0];
    expect(registryUpdate?.containerName).toBe("oc-test-shared");
    expect(registryUpdate?.configHash).toBe(newHash);
  });

  it("applies custom binds after workspace mounts so overlapping binds can override", async () => {
    const workspaceDir = "/tmp/workspace";
    const cfg = createSandboxConfig(
      ["1.1.1.1"],
      ["/tmp/workspace-shared/USER.md:/workspace/USER.md:ro"],
    );
    cfg.docker.dangerouslyAllowExternalBindSources = true;
    const expectedHash = computeSandboxConfigHash({
      docker: cfg.docker,
      workspaceAccess: cfg.workspaceAccess,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
    });

    spawnState.inspectRunning = false;
    spawnState.labelHash = "stale-hash";
    registryMocks.readRegistryEntry.mockResolvedValue({
      containerName: "oc-test-shared",
      sessionKey: "shared",
      createdAtMs: 1,
      lastUsedAtMs: 0,
      image: cfg.docker.image,
      configHash: "stale-hash",
    });

    const createCall = await ensureSandboxCreateCallForTest({ cfg, workspaceDir });
    expect(createCall.args).toContain(`openclaw.configHash=${expectedHash}`);

    const bindArgs = collectDockerFlagValues(createCall.args, "-v");
    const workspaceMountIdx = bindArgs.indexOf("/tmp/workspace:/workspace:z");
    const customMountIdx = bindArgs.indexOf("/tmp/workspace-shared/USER.md:/workspace/USER.md:ro");
    expect(workspaceMountIdx).toBeGreaterThanOrEqual(0);
    expect(customMountIdx).toBeGreaterThan(workspaceMountIdx);
  });

  it.each([
    { workspaceAccess: "rw" as const, expectedMainMount: "/tmp/workspace:/workspace:z" },
    { workspaceAccess: "ro" as const, expectedMainMount: "/tmp/workspace:/workspace:ro,z" },
    { workspaceAccess: "none" as const, expectedMainMount: "/tmp/workspace:/workspace:ro,z" },
  ])(
    "uses expected main mount permissions when workspaceAccess=$workspaceAccess",
    async ({ workspaceAccess, expectedMainMount }) => {
      const workspaceDir = "/tmp/workspace";
      const cfg = createSandboxConfig([], undefined, workspaceAccess);

      spawnState.inspectRunning = false;
      spawnState.labelHash = "";
      registryMocks.readRegistryEntry.mockResolvedValue(null);
      registryMocks.updateRegistry.mockResolvedValue(undefined);

      const createCall = await ensureSandboxCreateCallForTest({ cfg, workspaceDir });

      const bindArgs = collectDockerFlagValues(createCall.args, "-v");
      expect(bindArgs).toContain(expectedMainMount);
    },
  );

  it("stamps the mount format version label on created containers", async () => {
    const workspaceDir = "/tmp/workspace";
    const cfg = createSandboxConfig([]);

    spawnState.inspectRunning = false;
    spawnState.labelHash = "";
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    const createCall = await ensureSandboxCreateCallForTest({ cfg, workspaceDir });
    expect(createCall.args).toContain(
      `openclaw.mountFormatVersion=${SANDBOX_MOUNT_FORMAT_VERSION}`,
    );
  });

  it("throws a clear Docker sandbox create error without command args", async () => {
    const cfg = createSandboxConfig([]);
    spawnState.containerExists = false;
    queueDockerResult(["create"], {
      code: 125,
      stderr: "invalid mount config for type bind",
    });

    let error: unknown;
    try {
      await ensureSandboxContainer({
        sessionKey: "agent:main:session-1",
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/workspace",
        cfg,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(
      /Docker sandbox failed during create for container oc-test-shared \(image openclaw-sandbox:test\) with exit code 125/,
    );
    expect(message).toContain("invalid mount config");
    expect(message).not.toContain("create --name");
    expect(message).not.toContain("/tmp/workspace");
  });

  it("throws a clear start error for a stopped existing container", async () => {
    const workspaceDir = "/tmp/workspace";
    const cfg = createSandboxConfig([]);
    spawnState.inspectRunning = false;
    spawnState.labelHash = computeSandboxConfigHash({
      docker: cfg.docker,
      workspaceAccess: cfg.workspaceAccess,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
    });
    queueDockerResult(["start", "oc-test-shared"], {
      code: 1,
      stderr: "container failed to start",
    });

    await expect(
      ensureSandboxContainer({
        sessionKey: "agent:main:session-1",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        cfg,
      }),
    ).rejects.toThrow(
      /Docker sandbox failed during start for container oc-test-shared \(image openclaw-sandbox:test\) with exit code 1/,
    );
  });

  it("surfaces setupCommand failure clearly and does not retry it", async () => {
    const cfg = createSandboxConfig([]);
    cfg.docker.setupCommand = "echo setup";
    spawnState.containerExists = false;
    queueDockerResult(["exec", "-i", "oc-test-shared"], {
      code: 7,
      stderr: "setup failed",
    });

    await expect(
      ensureSandboxContainer({
        sessionKey: "agent:main:session-1",
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/workspace",
        cfg,
      }),
    ).rejects.toThrow(
      /Docker sandbox failed during setupCommand for container oc-test-shared \(image openclaw-sandbox:test\) with exit code 7/,
    );

    const execCalls = spawnState.calls.filter(
      (call) => call.command === "docker" && call.args[0] === "exec",
    );
    expect(execCalls).toHaveLength(1);
  });

  it("does not retry create failures", async () => {
    const cfg = createSandboxConfig([]);
    spawnState.containerExists = false;
    queueDockerResult(["create"], {
      code: 125,
      stderr: "invalid bind mount config",
    });

    await expect(
      ensureSandboxContainer({
        sessionKey: "agent:main:session-1",
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/workspace",
        cfg,
      }),
    ).rejects.toThrow(/invalid bind mount config/);

    const createCalls = spawnState.calls.filter(
      (call) => call.command === "docker" && call.args[0] === "create",
    );
    expect(createCalls).toHaveLength(1);
  });

  it("does not retry start failures", async () => {
    const workspaceDir = "/tmp/workspace";
    const cfg = createSandboxConfig([]);
    spawnState.inspectRunning = false;
    spawnState.labelHash = computeSandboxConfigHash({
      docker: cfg.docker,
      workspaceAccess: cfg.workspaceAccess,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
    });
    queueDockerResult(["start", "oc-test-shared"], {
      code: 1,
      stderr: "invalid restart policy",
    });

    await expect(
      ensureSandboxContainer({
        sessionKey: "agent:main:session-1",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        cfg,
      }),
    ).rejects.toThrow(/invalid restart policy/);

    const startCalls = spawnState.calls.filter(
      (call) => call.command === "docker" && call.args[0] === "start",
    );
    expect(startCalls).toHaveLength(1);
  });
});
