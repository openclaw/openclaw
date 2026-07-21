// Docker sandbox recreation tests cover config-hash labels, bind ordering, and
// mount labels used to decide when shared containers must be rebuilt.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeSandboxConfigHash,
  SANDBOX_DOCKER_EXPLICIT_ENV_POLICY_EPOCH,
} from "./config-hash.js";
import { SANDBOX_DOCKER_CREATE_ARGS_EPOCH } from "./constants.js";
import { collectDockerFlagValues } from "./test-args.js";
import type { SandboxConfig } from "./types.js";
import { SANDBOX_MOUNT_FORMAT_VERSION } from "./workspace-mounts.js";

type SpawnCall = {
  command: string;
  args: string[];
};

const spawnState = vi.hoisted(() => ({
  calls: [] as SpawnCall[],
  inspectRunning: true,
  labelHash: "",
  podmanInfo: "true\tfalse\n",
  podmanConnections: "[]\n",
}));

const registryMocks = vi.hoisted(() => ({
  readRegistryEntry: vi.fn(),
  updateRegistry: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({
  log: vi.fn(),
}));

const tmpDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docker-mounts-"));
  tmpDirs.push(dir);
  return dir;
}

vi.mock("./registry.js", () => ({
  readRegistryEntry: registryMocks.readRegistryEntry,
  updateRegistry: registryMocks.updateRegistry,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtimeMocks,
}));

async function spawnDockerProcess(commandAndArgs: string[]) {
  const [command = "", ...args] = commandAndArgs;
  // The tests assert docker CLI arguments without requiring Docker; this mock
  // implements only the inspect/create/start/rm calls used by ensureSandboxContainer.
  spawnState.calls.push({ command, args });

  let code = 0;
  let stdout = "";
  let stderr = "";
  if (command !== "docker" && command !== "podman") {
    code = 1;
    stderr = `unexpected command: ${command}`;
  } else if (args[0] === "inspect" && args[1] === "-f" && args[2] === "{{.State.Running}}") {
    stdout = spawnState.inspectRunning ? "true\n" : "false\n";
  } else if (
    args[0] === "inspect" &&
    args[1] === "-f" &&
    args[2]?.includes('index .Config.Labels "openclaw.configHash"')
  ) {
    stdout = `${spawnState.labelHash}\n`;
  } else if (command === "podman" && args[0] === "info") {
    stdout = spawnState.podmanInfo;
  } else if (command === "podman" && args[0] === "system") {
    stdout = spawnState.podmanConnections;
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
  return {
    failed: code !== 0,
    isCanceled: false,
    exitCode: code,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  };
}

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  spawnCommand: spawnDockerProcess,
}));

let ensureSandboxContainer: typeof import("./docker.js").ensureSandboxContainer;
let resolveDockerEnvPolicyEpoch: typeof import("./docker.js").resolveDockerEnvPolicyEpoch;
let PODMAN_SANDBOX_ENGINE: typeof import("./docker.js").PODMAN_SANDBOX_ENGINE;

async function loadFreshDockerModuleForTest() {
  vi.resetModules();
  vi.doMock("./registry.js", () => ({
    readRegistryEntry: registryMocks.readRegistryEntry,
    updateRegistry: registryMocks.updateRegistry,
  }));
  vi.doMock("../../process/exec.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../process/exec.js")>()),
    spawnCommand: spawnDockerProcess,
  }));
  ({ ensureSandboxContainer, resolveDockerEnvPolicyEpoch, PODMAN_SANDBOX_ENGINE } =
    await import("./docker.js"));
}

function createSandboxConfig(
  dns: string[],
  binds?: string[],
  workspaceAccess: "rw" | "ro" | "none" = "rw",
  env: Record<string, string> = { LANG: "C.UTF-8" },
): SandboxConfig {
  return {
    mode: "all",
    backend: "docker",
    scope: "shared",
    workspaceAccess,
    workspaceRoot: "~/.openclaw/sandboxes",
    dockerTmpfsSource: "default",
    docker: {
      image: "openclaw-sandbox:test",
      containerPrefix: "oc-test-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: ["/tmp", "/var/tmp", "/run"],
      network: "none",
      capDrop: ["ALL"],
      env,
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
  engine?: import("./docker.js").SandboxContainerEngine;
}): Promise<SpawnCall> {
  const workspaceDir = params.workspaceDir ?? "/tmp/workspace";
  await ensureSandboxContainer({
    sessionKey: params.sessionKey ?? "agent:main:session-1",
    workspaceDir,
    agentWorkspaceDir: workspaceDir,
    cfg: params.cfg,
    ...(params.engine ? { engine: params.engine } : {}),
  });

  const createCall = spawnState.calls.find(
    (call) => call.command === (params.engine?.command ?? "docker") && call.args[0] === "create",
  );
  if (!createCall) {
    throw new Error(`expected ${params.engine?.command ?? "docker"} create call`);
  }
  return createCall;
}

describe("ensureSandboxContainer config-hash recreation", () => {
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    spawnState.calls.length = 0;
    spawnState.inspectRunning = true;
    spawnState.labelHash = "";
    spawnState.podmanInfo = "true\tfalse\n";
    spawnState.podmanConnections = "[]\n";
    registryMocks.readRegistryEntry.mockClear();
    registryMocks.updateRegistry.mockClear();
    registryMocks.updateRegistry.mockResolvedValue(undefined);
    runtimeMocks.log.mockClear();
    await loadFreshDockerModuleForTest();
  });

  it("recreates shared container when array-order change alters hash", async () => {
    // Docker flag order is part of the runtime contract, so order-sensitive
    // config changes must invalidate a shared container.
    const workspaceDir = makeTempDir();
    const oldCfg = createSandboxConfig(["1.1.1.1", "8.8.8.8"], [`${workspaceDir}:/workspace:rw`]);
    const newCfg = createSandboxConfig(["8.8.8.8", "1.1.1.1"], [`${workspaceDir}:/workspace:rw`]);

    const oldHash = computeSandboxConfigHash({
      docker: oldCfg.docker,
      workspaceAccess: oldCfg.workspaceAccess,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
      readOnlyWorkspaceSkillMounts: [],
    });
    const newHash = computeSandboxConfigHash({
      docker: newCfg.docker,
      workspaceAccess: newCfg.workspaceAccess,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
      readOnlyWorkspaceSkillMounts: [],
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

  it("recreates a cold container when the shared Docker create-args epoch changes", async () => {
    const workspaceDir = makeTempDir();
    // Keep the create-args epoch as the only hash delta in this scenario.
    const cfg = createSandboxConfig([], [`${workspaceDir}:/workspace:rw`], "rw", {});
    const hashInput = {
      docker: cfg.docker,
      dockerEnvPolicyEpoch: resolveDockerEnvPolicyEpoch(cfg.docker.env),
      workspaceAccess: cfg.workspaceAccess,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      readOnlyWorkspaceSkillMounts: [],
    };
    const oldHash = computeSandboxConfigHash({
      ...hashInput,
      createArgsEpoch: "pre-init",
    });
    const newHash = computeSandboxConfigHash({
      ...hashInput,
      createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
    });

    spawnState.labelHash = oldHash;
    registryMocks.readRegistryEntry.mockResolvedValue({
      containerName: "oc-test-shared",
      sessionKey: "shared",
      createdAtMs: 1,
      lastUsedAtMs: 0,
      image: cfg.docker.image,
      configHash: oldHash,
    });

    const createCall = await ensureSandboxCreateCallForTest({ cfg, workspaceDir });
    expect(spawnState.calls.some((call) => call.args[0] === "rm")).toBe(true);
    expect(createCall.args.filter((arg) => arg === "--init")).toHaveLength(1);
    expect(createCall.args).toContain(
      `openclaw.createArgsEpoch=${SANDBOX_DOCKER_CREATE_ARGS_EPOCH}`,
    );
    expect(createCall.args).toContain(`openclaw.configHash=${newHash}`);
  });

  it("keeps a hot pre-init container running and emits the recreate hint", async () => {
    const workspaceDir = makeTempDir();
    const cfg = createSandboxConfig([], [`${workspaceDir}:/workspace:rw`], "rw", {});
    const oldHash = computeSandboxConfigHash({
      docker: cfg.docker,
      dockerEnvPolicyEpoch: resolveDockerEnvPolicyEpoch(cfg.docker.env),
      workspaceAccess: cfg.workspaceAccess,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      createArgsEpoch: "pre-init",
      readOnlyWorkspaceSkillMounts: [],
    });
    spawnState.labelHash = oldHash;
    registryMocks.readRegistryEntry.mockResolvedValue({
      containerName: "oc-test-shared",
      sessionKey: "shared",
      createdAtMs: 1,
      lastUsedAtMs: Date.now(),
      image: cfg.docker.image,
      configHash: oldHash,
    });

    await ensureSandboxContainer({
      sessionKey: "agent:main:session-1",
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      cfg,
    });

    expect(spawnState.calls.some((call) => call.args[0] === "rm")).toBe(false);
    expect(spawnState.calls.some((call) => call.args[0] === "create")).toBe(false);
    expect(runtimeMocks.log).toHaveBeenCalledWith(
      expect.stringContaining("Recreate to apply: openclaw sandbox recreate --all"),
    );
    expect(registryMocks.updateRegistry.mock.calls.at(-1)?.[0]?.configHash).toBe(oldHash);
  });

  it("rejects a hot stale container when current config is required", async () => {
    const workspaceDir = makeTempDir();
    const cfg = createSandboxConfig([], [`${workspaceDir}:/workspace:rw`], "rw", {});
    spawnState.labelHash = "stale-hash";
    registryMocks.readRegistryEntry.mockResolvedValue({
      containerName: "oc-test-shared",
      sessionKey: "shared",
      createdAtMs: 1,
      lastUsedAtMs: Date.now(),
      image: cfg.docker.image,
      configHash: "stale-hash",
    });

    await expect(
      ensureSandboxContainer({
        sessionKey: "agent:main:session-1",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        cfg,
        requireCurrentConfig: true,
      }),
    ).rejects.toThrow("restricted dispatch requires the current container config");
    expect(spawnState.calls.some((call) => call.args[0] === "rm")).toBe(false);
    expect(spawnState.calls.some((call) => call.args[0] === "create")).toBe(false);
    expect(registryMocks.updateRegistry).not.toHaveBeenCalled();
  });

  it("recreates shared container when previously filtered explicit env becomes allowed", async () => {
    const workspaceDir = makeTempDir();
    const cfg = createSandboxConfig(["1.1.1.1"], undefined, "rw", {
      LANG: "C.UTF-8",
      GEMINI_API_KEY: "dummy-gemini",
    });
    cfg.docker.binds = [`${workspaceDir}:/workspace:rw`];

    const oldHash = computeSandboxConfigHash({
      docker: cfg.docker,
      workspaceAccess: cfg.workspaceAccess,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
      readOnlyWorkspaceSkillMounts: [],
    });
    const newHash = computeSandboxConfigHash({
      docker: cfg.docker,
      dockerEnvPolicyEpoch: SANDBOX_DOCKER_EXPLICIT_ENV_POLICY_EPOCH,
      workspaceAccess: cfg.workspaceAccess,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
      readOnlyWorkspaceSkillMounts: [],
    });
    expect(newHash).not.toBe(oldHash);

    spawnState.labelHash = oldHash;
    registryMocks.readRegistryEntry.mockResolvedValue({
      containerName: "oc-test-shared",
      sessionKey: "shared",
      createdAtMs: 1,
      lastUsedAtMs: 0,
      image: cfg.docker.image,
      configHash: oldHash,
    });

    const createCall = await ensureSandboxCreateCallForTest({ cfg, workspaceDir });
    expect(createCall.args).toContain(`openclaw.configHash=${newHash}`);
    expect(collectDockerFlagValues(createCall.args, "--env")).toEqual(
      expect.arrayContaining(["LANG=C.UTF-8", "GEMINI_API_KEY=dummy-gemini"]),
    );

    const registryUpdate = registryMocks.updateRegistry.mock.calls.at(-1)?.[0];
    expect(registryUpdate?.configHash).toBe(newHash);
  });

  it("applies custom binds after workspace mounts so overlapping binds can override", async () => {
    const workspaceDir = makeTempDir();
    const customRoot = makeTempDir();
    const customUserFile = path.join(customRoot, "USER.md");
    const cfg = createSandboxConfig(["1.1.1.1"], [`${customUserFile}:/workspace/USER.md:ro`]);
    cfg.docker.dangerouslyAllowExternalBindSources = true;
    const expectedHash = computeSandboxConfigHash({
      docker: cfg.docker,
      workspaceAccess: cfg.workspaceAccess,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
      readOnlyWorkspaceSkillMounts: [],
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
    const workspaceMountIdx = bindArgs.indexOf(`${workspaceDir}:/workspace:z`);
    const customMountIdx = bindArgs.indexOf(`${customUserFile}:/workspace/USER.md:ro`);
    expect(workspaceMountIdx).toBeGreaterThanOrEqual(0);
    expect(customMountIdx).toBeGreaterThan(workspaceMountIdx);
  });

  it("applies read-only skill overlays after custom binds", async () => {
    // Protected skill overlays must be appended last so even an overlapping
    // custom bind cannot make checked-in skills writable.
    const workspaceDir = makeTempDir();
    const customRoot = makeTempDir();
    fs.mkdirSync(path.join(workspaceDir, "skills", "demo"), { recursive: true });
    fs.mkdirSync(customRoot, { recursive: true });
    const cfg = createSandboxConfig([], [`${customRoot}:/workspace/skills:rw`]);
    cfg.docker.dangerouslyAllowExternalBindSources = true;

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
    const bindArgs = collectDockerFlagValues(createCall.args, "-v");
    const workspaceMountIdx = bindArgs.indexOf(`${workspaceDir}:/workspace:z`);
    const customMountIdx = bindArgs.indexOf(`${customRoot}:/workspace/skills:rw`);
    const protectedMountIdx = bindArgs.indexOf(
      `${path.join(workspaceDir, "skills")}:/workspace/skills:ro,z`,
    );

    expect(workspaceMountIdx).toBeGreaterThanOrEqual(0);
    expect(customMountIdx).toBeGreaterThan(workspaceMountIdx);
    expect(protectedMountIdx).toBeGreaterThan(customMountIdx);
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

  it("uses the shared lifecycle with Podman keep-id ownership", async () => {
    const workspaceDir = "/tmp/workspace";
    const cfg = createSandboxConfig([]);
    cfg.docker.user = undefined;
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    const createCall = await ensureSandboxCreateCallForTest({
      cfg,
      workspaceDir,
      engine: PODMAN_SANDBOX_ENGINE,
    });

    expect(createCall.command).toBe("podman");
    expect(collectDockerFlagValues(createCall.args, "--userns")).toEqual(["keep-id"]);
    expect(collectDockerFlagValues(createCall.args, "--user")).toEqual([]);
    expect(createCall.args).toContain("--http-proxy=false");
    expect(createCall.args).toContain("--init");
    expect(createCall.args).toContain("--read-only-tmpfs=true");
    expect(collectDockerFlagValues(createCall.args, "--tmpfs")).toEqual(["/tmp", "/var/tmp"]);
    expect(collectDockerFlagValues(createCall.args, "-v")).toContain(
      `${workspaceDir}:/workspace:z`,
    );
    expect(registryMocks.updateRegistry.mock.calls.at(-1)?.[0]?.backendId).toBe("podman");
  });

  it("preserves legacy Docker name truncation for a long container prefix", async () => {
    const cfg = createSandboxConfig([]);
    cfg.scope = "session";
    cfg.docker.containerPrefix = "x".repeat(56);
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    const createCall = await ensureSandboxCreateCallForTest({
      cfg,
      sessionKey: "agent:first:session",
    });
    const containerName = collectDockerFlagValues(createCall.args, "--name")[0];

    expect(containerName).toHaveLength(63);
    expect(containerName?.startsWith(cfg.docker.containerPrefix)).toBe(true);
  });

  it("preserves distinct session suffixes with a long Podman container prefix", async () => {
    const cfg = createSandboxConfig([]);
    cfg.scope = "session";
    cfg.docker.containerPrefix = "x".repeat(56);
    cfg.docker.user = undefined;
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    const firstCreate = await ensureSandboxCreateCallForTest({
      cfg,
      sessionKey: "agent:first:session",
      engine: PODMAN_SANDBOX_ENGINE,
    });
    const firstName = collectDockerFlagValues(firstCreate.args, "--name")[0];

    spawnState.calls.length = 0;
    const secondCreate = await ensureSandboxCreateCallForTest({
      cfg,
      sessionKey: "agent:second:session",
      engine: PODMAN_SANDBOX_ENGINE,
    });
    const secondName = collectDockerFlagValues(secondCreate.args, "--name")[0];

    expect(firstName).not.toBe(secondName);
    expect(firstName?.length).toBeLessThanOrEqual(63);
    expect(secondName?.length).toBeLessThanOrEqual(63);
  });

  it("uses Podman init when mounts leave podman-init visible", async () => {
    const cfg = createSandboxConfig([]);
    cfg.docker.tmpfs = ["/tmp", "/var/tmp"];
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    const createCall = await ensureSandboxCreateCallForTest({
      cfg,
      engine: PODMAN_SANDBOX_ENGINE,
    });

    expect(createCall.args).toContain("--init");
  });

  it("rejects a workdir whose managed workspace bind would cover Podman init", async () => {
    const cfg = createSandboxConfig([]);
    cfg.docker.workdir = "/run";
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    await expect(
      ensureSandboxCreateCallForTest({ cfg, engine: PODMAN_SANDBOX_ENGINE }),
    ).rejects.toThrow("would cover Podman's init path");
  });

  it("omits the default /run tmpfs for writable-root Podman sandboxes", async () => {
    const cfg = createSandboxConfig([]);
    cfg.docker.readOnlyRoot = false;
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    const createCall = await ensureSandboxCreateCallForTest({
      cfg,
      engine: PODMAN_SANDBOX_ENGINE,
    });

    expect(createCall.args).toContain("--init");
    expect(createCall.args).not.toContain("--read-only-tmpfs=true");
    expect(collectDockerFlagValues(createCall.args, "--tmpfs")).toEqual(["/tmp", "/var/tmp"]);
  });

  it("rejects an explicitly configured bare /run tmpfs", async () => {
    const cfg = createSandboxConfig([]);
    cfg.dockerTmpfsSource = "configured";
    cfg.docker.readOnlyRoot = false;
    cfg.docker.tmpfs = ["/run"];
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    await expect(
      ensureSandboxCreateCallForTest({ cfg, engine: PODMAN_SANDBOX_ENGINE }),
    ).rejects.toThrow("would cover Podman's init path");
  });

  it("invalidates a Podman container when the same tmpfs list becomes explicit", async () => {
    const workspaceDir = makeTempDir();
    const cfg = createSandboxConfig([], [`${workspaceDir}:/workspace:rw`]);
    const genericHash = computeSandboxConfigHash({
      docker: cfg.docker,
      dockerEnvPolicyEpoch: resolveDockerEnvPolicyEpoch(cfg.docker.env),
      workspaceAccess: cfg.workspaceAccess,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
      readOnlyWorkspaceSkillMounts: [],
    });
    const oldHash = `${genericHash}:podman-runtime-v5:keep-id:default`;
    cfg.dockerTmpfsSource = "configured";
    spawnState.inspectRunning = false;
    spawnState.labelHash = oldHash;
    registryMocks.readRegistryEntry.mockResolvedValue({
      containerName: "oc-test-podman-shared",
      sessionKey: "shared",
      createdAtMs: 1,
      lastUsedAtMs: 0,
      image: cfg.docker.image,
      configHash: oldHash,
    });

    await expect(
      ensureSandboxContainer({
        engine: PODMAN_SANDBOX_ENGINE,
        sessionKey: "agent:main:session-1",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        cfg,
      }),
    ).rejects.toThrow("would cover Podman's init path");

    expect(
      spawnState.calls.some(
        (call) => call.command === "podman" && call.args[0] === "rm" && call.args[1] === "-f",
      ),
    ).toBe(true);
  });

  it("rejects customized /run tmpfs options instead of discarding them", async () => {
    const cfg = createSandboxConfig([]);
    cfg.dockerTmpfsSource = "configured";
    cfg.docker.tmpfs = ["/run:size=64m,mode=0700"];
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    await expect(
      ensureSandboxCreateCallForTest({ cfg, engine: PODMAN_SANDBOX_ENGINE }),
    ).rejects.toThrow("would cover Podman's init path");
  });

  it("allows Podman Machine workspaces under the default home share", async () => {
    const cfg = createSandboxConfig([]);
    const workspaceDir = path.join(os.homedir(), "openclaw-podman-workspace");
    cfg.docker.binds = [`${workspaceDir}:/workspace:rw`];
    spawnState.podmanInfo = "true\ttrue\n";
    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "podman-machine-default",
        URI: "ssh://core@127.0.0.1/run/user/501/podman/podman.sock",
        IsMachine: true,
        Default: true,
      },
    ]);
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    const createCall = await ensureSandboxCreateCallForTest({
      cfg,
      workspaceDir,
      engine: PODMAN_SANDBOX_ENGINE,
    });

    expect(createCall.command).toBe("podman");
  });

  it("rejects Podman Machine bind sources outside the default home share", async () => {
    const cfg = createSandboxConfig([]);
    spawnState.podmanInfo = "true\ttrue\n";
    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "podman-machine-default",
        URI: "ssh://core@127.0.0.1/run/user/501/podman/podman.sock",
        IsMachine: true,
        Default: true,
      },
    ]);
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    await expect(
      ensureSandboxContainer({
        engine: PODMAN_SANDBOX_ENGINE,
        sessionKey: "agent:test:session",
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/workspace",
        cfg,
      }),
    ).rejects.toThrow(/outside the default host home share/u);

    expect(spawnState.calls.some((call) => call.args[0] === "create")).toBe(false);
  });
});
