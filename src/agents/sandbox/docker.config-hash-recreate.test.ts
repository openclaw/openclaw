import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import "../../test-utils/prepare-compiled-subprocesses.js";
import { SANDBOX_DOCKER_EXPLICIT_ENV_POLICY_EPOCH } from "./config-hash.js";
import { SANDBOX_DOCKER_CREATE_ARGS_EPOCH } from "./constants.js";
import { createSandboxContainerTestHarness } from "./docker.create.test-helpers.js";
import { collectDockerFlagValues } from "./test-args.js";
import { SANDBOX_MOUNT_FORMAT_VERSION } from "./workspace-mounts.js";

describe("ensureSandboxContainer recreation and managed mounts", () => {
  const harness = createSandboxContainerTestHarness();
  const {
    spawnState,
    registryMocks,
    tempDirs,
    usePodmanMachine,
    createSandboxConfig,
    computeTestSandboxHash,
    ensureSandboxCreateCallForTest,
    resolveDockerSourceNamespace,
  } = harness;

  const containerParams = (
    cfg: Parameters<typeof harness.ensureSandboxContainer>[0]["cfg"],
    workspaceDir = "/tmp/workspace",
  ) => ({ scopeKey: "shared", workspaceDir, agentWorkspaceDir: workspaceDir, cfg });
  const podmanParams = (cfg: Parameters<typeof containerParams>[0], workspaceDir?: string) => ({
    ...containerParams(cfg, workspaceDir),
    engine: harness.PODMAN_SANDBOX_ENGINE,
  });
  const createPodman = (cfg: Parameters<typeof containerParams>[0], workspaceDir: string) =>
    ensureSandboxCreateCallForTest(podmanParams(cfg, workspaceDir));
  const calls = (operation: string) =>
    spawnState.calls.filter((call) => call.args[0] === operation);
  const expectNoMutation = () => {
    expect(spawnState.calls.some((call) => ["rm", "create", "start"].includes(call.args[0]!))).toBe(
      false,
    );
  };
  const recordContainer = (
    cfg: Parameters<typeof containerParams>[0],
    entry: Record<string, unknown>,
  ) =>
    registryMocks.readRegistryEntry.mockResolvedValue({
      containerName: "oc-test-shared",
      sessionKey: "shared",
      createdAtMs: 1,
      lastUsedAtMs: 0,
      image: cfg.docker.image,
      ...entry,
    });
  const prepareCreation = (missing = false) => {
    spawnState.inspectRunning = false;
    if (missing) {
      spawnState.containerExists = false;
    }
    registryMocks.readRegistryEntry.mockResolvedValue(null);
  };

  const hashInput = (cfg: Parameters<typeof containerParams>[0], workspaceDir: string) => ({
    docker: cfg.docker,
    workspaceAccess: cfg.workspaceAccess,
    workspaceDir,
    agentWorkspaceDir: workspaceDir,
    mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
    createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
  });

  it("serializes concurrent provisioning for one container", async () => {
    const workspaceDir = tempDirs.make("openclaw-docker-mounts-");
    const cfg = createSandboxConfig([], [`${workspaceDir}:/workspace:rw`]);
    prepareCreation(true);

    const params = containerParams(cfg, workspaceDir);
    const [first, second] = await Promise.all([
      harness.ensureSandboxContainer(params),
      harness.ensureSandboxContainer(params),
    ]);

    expect(first).toEqual({ containerName: "oc-test-shared", containerId: "c".repeat(64) });
    expect(second).toEqual(first);
    expect(calls("create")).toHaveLength(1);
    expect(calls("start")).toHaveLength(1);
    expect(registryMocks.updateRegistry).toHaveBeenCalledTimes(2);
  });

  it.each(["docker", "podman"] as const)(
    "completes %s setup after recreation with retained registry custody",
    async (backendId) => {
      const { withOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
      const registry = await vi.importActual<typeof import("./registry.js")>("./registry.js");
      registryMocks.readRegistryEntry.mockImplementation(registry.readRegistryEntry);
      registryMocks.updateRegistry.mockImplementation(registry.updateRegistry);
      registryMocks.completeSandboxRegistryReservation.mockImplementation(
        registry.completeSandboxRegistryReservation,
      );
      registryMocks.removeRegistryEntry.mockImplementation(registry.removeRegistryEntry);
      try {
        await withOpenClawTestState({ label: "sandbox-setup-recreation" }, async (state) => {
          const workspaceDir = state.workspaceDir;
          const retainedWorkspaceDir = state.path("retained-workspace");
          fs.mkdirSync(retainedWorkspaceDir);
          const cfg = createSandboxConfig([], []);
          cfg.backend = backendId;
          cfg.docker.setupCommand = "echo setup";
          const containerName = backendId === "podman" ? "oc-test-podman-shared" : "oc-test-shared";
          await registry.updateRegistry({
            containerName,
            backendId,
            ...(backendId === "podman" ? { backendTarget: { key: "local", globalArgs: [] } } : {}),
            sessionKey: "shared",
            workspaceDir: retainedWorkspaceDir,
            createdAtMs: 1,
            lastUsedAtMs: 1,
            image: cfg.docker.image,
            configHash: "stale-hash",
            runtimeState: "ready",
          });
          spawnState.inspectRunning = false;
          spawnState.labelHash = "stale-hash";

          await expect(
            harness.ensureSandboxContainer({
              ...(backendId === "podman" ? { engine: harness.PODMAN_SANDBOX_ENGINE } : {}),
              ...containerParams(cfg, workspaceDir),
            }),
          ).resolves.toEqual({ containerName, containerId: "c".repeat(64) });

          await expect(registry.readRegistryEntry(containerName)).resolves.toMatchObject({
            runtimeState: "ready",
            createdAtMs: 1,
            workspaceDir: retainedWorkspaceDir,
            configHash: spawnState.labelHash,
          });
          expect(calls("exec")).toHaveLength(1);
          expect(calls("rm")).toHaveLength(1);
          expect(spawnState).toMatchObject({ containerExists: true, inspectRunning: true });
        });
      } finally {
        registryMocks.readRegistryEntry.mockReset();
        registryMocks.updateRegistry.mockReset();
        registryMocks.completeSandboxRegistryReservation.mockReset();
        registryMocks.removeRegistryEntry.mockReset();
      }
    },
  );

  it("uses the canonical non-shared scope for Docker names, labels, and registry identity", async () => {
    const workspaceDir = tempDirs.make("openclaw-docker-mounts-");
    const cfg = createSandboxConfig([], [`${workspaceDir}:/workspace:rw`]);
    cfg.scope = "agent";
    prepareCreation(true);
    const scopeKey = `agent:poly:workspace:${"a".repeat(32)}`;

    const createCall = await ensureSandboxCreateCallForTest({ cfg, workspaceDir, scopeKey });

    const containerName = createCall.args[createCall.args.indexOf("--name") + 1];
    expect(containerName).toMatch(/^oc-test-workspace-[a-f0-9]{32}$/);
    expect(createCall.args).toContain(`openclaw.sessionKey=${scopeKey}`);
    expect(registryMocks.updateRegistry.mock.calls.at(-1)?.[0]).toMatchObject({
      containerName,
      sessionKey: scopeKey,
    });
  });

  it("rejects a hot stale container when current config is required", async () => {
    const workspaceDir = tempDirs.make("openclaw-docker-mounts-");
    const cfg = createSandboxConfig([], [`${workspaceDir}:/workspace:rw`], "rw", {});
    spawnState.labelHash = "stale-hash";
    recordContainer(cfg, {
      lastUsedAtMs: Date.now(),
      configHash: "stale-hash",
    });

    await expect(
      harness.ensureSandboxContainer({
        ...containerParams(cfg, workspaceDir),
        requireCurrentConfig: true,
      }),
    ).rejects.toThrow("restricted dispatch requires the current container config");
    expect(spawnState.calls.some((call) => call.args[0] === "rm")).toBe(false);
    expect(spawnState.calls.some((call) => call.args[0] === "create")).toBe(false);
    expect(registryMocks.updateRegistry).not.toHaveBeenCalled();
  });

  it("recreates shared container when previously filtered explicit env becomes allowed", async () => {
    const workspaceDir = tempDirs.make("openclaw-docker-mounts-");
    const cfg = createSandboxConfig(["1.1.1.1"], undefined, "rw", {
      LANG: "C.UTF-8",
      GEMINI_API_KEY: "dummy-gemini",
    });
    cfg.docker.binds = [`${workspaceDir}:/workspace:rw`];

    const oldHash = await computeTestSandboxHash(hashInput(cfg, workspaceDir));
    const newHash = await computeTestSandboxHash({
      ...hashInput(cfg, workspaceDir),
      dockerEnvPolicyEpoch: SANDBOX_DOCKER_EXPLICIT_ENV_POLICY_EPOCH,
    });
    expect(newHash).not.toBe(oldHash);

    spawnState.labelHash = oldHash;
    recordContainer(cfg, { configHash: oldHash });

    const createCall = await ensureSandboxCreateCallForTest({ cfg, workspaceDir });
    expect(createCall.args).toContain(`openclaw.configHash=${newHash}`);
    expect(createCall.args).not.toContain("--env");
    expect(createCall.envFileContents).toContain("LANG=C.UTF-8\n");
    expect(createCall.envFileContents).toContain("GEMINI_API_KEY=dummy-gemini\n");
    expect(createCall.args.join(" ")).not.toContain("dummy-gemini");
    expect(createCall.envFileContents).toContain("OPENCLAW_CLI=1\n");
    const envFile = collectDockerFlagValues(createCall.args, "--env-file")[0];
    expect(envFile).toBeDefined();
    expect(fs.existsSync(envFile!)).toBe(false);
    expect(createCall.args.filter((arg) => arg === "--init")).toHaveLength(1);
    expect(createCall.args).toContain(
      `openclaw.createArgsEpoch=${SANDBOX_DOCKER_CREATE_ARGS_EPOCH}`,
    );

    const registryUpdate = registryMocks.updateRegistry.mock.calls.at(-1)?.[0];
    expect(registryUpdate?.configHash).toBe(newHash);
  });

  it("reports a missing Podman init dependency without weakening or completing provisioning", async () => {
    const workspaceDir = tempDirs.make("openclaw-podman-init-");
    const cfg = createSandboxConfig([], [], "rw", {});
    cfg.backend = "podman";
    cfg.docker.setupCommand = "echo setup-must-not-run";
    prepareCreation(true);
    spawnState.createError =
      'Error: lookup init binary: exec: "catatonit": executable file not found in $PATH\n';

    const error = await harness
      .ensureSandboxContainer(podmanParams(cfg, workspaceDir))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: expect.stringContaining("Install catatonit on the Podman engine host"),
      code: 125,
      stderr: Buffer.from(spawnState.createError),
    });
    const creates = calls("create");
    expect(creates).toHaveLength(1);
    const create = creates[0]!;
    expect(create.command).toBe("podman");
    expect(create.args.filter((arg) => arg === "--init")).toHaveLength(1);
    expect(create.args).toContain("--read-only");
    expect(collectDockerFlagValues(create.args, "--network")).toEqual(["none"]);
    expect(collectDockerFlagValues(create.args, "--cap-drop")).toEqual(["ALL"]);
    expect(collectDockerFlagValues(create.args, "--security-opt")).toContain("no-new-privileges");
    expect(
      spawnState.calls.some((call) => ["start", "exec", "rm"].includes(call.args[0] ?? "")),
    ).toBe(false);
    expect(registryMocks.updateRegistry).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeState: "pending" }),
    );
    expect(registryMocks.completeSandboxRegistryReservation).not.toHaveBeenCalled();
    expect(registryMocks.removeRegistryEntry).not.toHaveBeenCalled();
    const envFile = collectDockerFlagValues(create.args, "--env-file")[0];
    expect(envFile).toBeDefined();
    expect(fs.existsSync(envFile!)).toBe(false);
  });

  it("uses the shared lifecycle with rootless Podman workspace ownership", async () => {
    const workspaceDir = "/tmp/workspace";
    const cfg = createSandboxConfig([], []);
    cfg.docker.user = "1001:1002";
    prepareCreation();

    const createCall = await createPodman(cfg, workspaceDir);

    expect(createCall.command).toBe("podman");
    expect(collectDockerFlagValues(createCall.args, "--userns")).toEqual([
      "keep-id:uid=1001,gid=1002",
    ]);
    expect(collectDockerFlagValues(createCall.args, "--user")).toEqual(["1001:1002"]);
    expect(createCall.args).toEqual(
      expect.arrayContaining(["--http-proxy=false", "--init", "--read-only-tmpfs=true"]),
    );
    expect(collectDockerFlagValues(createCall.args, "--tmpfs")).toEqual(["/tmp", "/var/tmp"]);
    expect(collectDockerFlagValues(createCall.args, "-v")).toContain(
      `${workspaceDir}:/workspace:z`,
    );
    const update = registryMocks.updateRegistry.mock.calls.at(-1)?.[0];
    expect(update?.backendId).toBe("podman");
    expect(update?.backendTarget).toEqual({ key: "local", globalArgs: [] });
  });

  it.each([
    { user: "0", error: /cannot use UID or GID 0/iu },
    { user: "1001:000", error: /cannot use UID or GID 0/iu },
    { user: "node", error: /must be a numeric UID or UID:GID/iu },
    { user: "1001:1002", version: "4.2.0", error: /requires Podman 4\.3 or newer/iu },
    {
      gpus: "all",
      rootless: false,
      version: "4.9.3",
      error: /GPU passthrough requires Podman 5\.0 or newer/iu,
    },
  ])(
    "rejects unsupported Podman policy %j before creation",
    async ({ user, gpus, rootless = true, version = "5.0.0", error }) => {
      const cfg = createSandboxConfig([]);
      cfg.docker.user = user;
      cfg.docker.gpus = gpus;
      spawnState.podmanInfo = `${rootless}\tfalse\t\t${version}\n`;
      prepareCreation();
      await expect(harness.ensureSandboxContainer(podmanParams(cfg))).rejects.toThrow(error);
      expect(spawnState.calls).not.toContainEqual(
        expect.objectContaining({ command: "podman", args: expect.arrayContaining(["create"]) }),
      );
    },
  );

  it.each(["changed", "missing", "unreachable"] as const)(
    "handles a recorded Podman target that is %s",
    async (state) => {
      const cfg = createSandboxConfig([]);
      const containerName = "oc-test-podman-shared";
      const backendTarget =
        state === "changed"
          ? { key: "local", globalArgs: [] }
          : {
              key: `machine:${"a".repeat(32)}`,
              globalArgs: ["--url", "ssh://core@127.0.0.1:60001/run/user/501/podman/podman.sock"],
            };
      if (state === "changed") {
        usePodmanMachine();
      } else if (state === "missing") {
        spawnState.containerExists = spawnState.inspectRunning = false;
        spawnState.inspectError =
          'Error: no container with name or ID "oc-test-podman-shared" found: no such container';
      } else {
        spawnState.inspectError = "Error: unable to connect to Podman socket: connection refused";
      }
      recordContainer(cfg, {
        containerName,
        backendId: "podman",
        backendTarget,
        lastUsedAtMs: 1,
      });
      const operation = harness.ensureSandboxContainer(podmanParams(cfg));
      const createCall = expect.objectContaining({
        command: "podman",
        globalArgs: [],
        args: expect.arrayContaining(["create", "--name", containerName]),
      });
      if (state === "missing") {
        await expect(operation).resolves.toEqual({ containerName, containerId: "c".repeat(64) });
        expect(registryMocks.removeRegistryEntry).toHaveBeenCalledWith(containerName);
        expect(spawnState.calls).toContainEqual(createCall);
      } else {
        await expect(operation).rejects.toThrow(
          state === "changed"
            ? /active Podman connection changed/u
            : /unable to connect to Podman socket/iu,
        );
        expect(registryMocks.removeRegistryEntry).not.toHaveBeenCalled();
        expect(spawnState.calls).not.toContainEqual(
          state === "changed"
            ? expect.objectContaining({
                command: "podman",
                globalArgs: [],
                args: expect.arrayContaining(["inspect"]),
              })
            : createCall,
        );
      }
    },
  );

  it("invalidates a Podman container when the same tmpfs list becomes explicit", async () => {
    const workspaceDir = tempDirs.make("openclaw-docker-mounts-");
    const cfg = createSandboxConfig([], [`${workspaceDir}:/workspace:rw`]);
    const genericHash = await computeTestSandboxHash({
      ...hashInput(cfg, workspaceDir),
      dockerEnvPolicyEpoch: harness.resolveDockerEnvPolicyEpoch(cfg.docker.env),
    });
    const oldHash = `${genericHash}:podman-runtime-v8:keep-id:default`;
    cfg.dockerTmpfsSource = "configured";
    spawnState.inspectRunning = false;
    spawnState.labelHash = oldHash;
    recordContainer(cfg, {
      containerName: "oc-test-podman-shared",
      backendId: "podman",
      backendTarget: { key: "local", globalArgs: [] },
      configHash: oldHash,
    });

    await expect(
      harness.ensureSandboxContainer({
        ...podmanParams(cfg, workspaceDir),
        scopeKey: "agent:main:session-1",
      }),
    ).rejects.toThrow("would cover Podman's init path");

    expect(
      spawnState.calls.some(
        (call) => call.command === "podman" && call.args[0] === "rm" && call.args[1] === "-f",
      ),
    ).toBe(true);
  });

  it("allows Podman Machine workspaces under the default home share", async () => {
    const cfg = createSandboxConfig([]);
    const workspaceDir = path.join(os.homedir(), "openclaw-podman-workspace");
    cfg.docker.binds = [`${workspaceDir}:/workspace:rw`];
    usePodmanMachine();
    prepareCreation();

    const createCall = await createPodman(cfg, workspaceDir);

    expect(createCall.command).toBe("podman");
    expect(createCall.globalArgs).toEqual([
      "--url",
      "ssh://core@127.0.0.1:60000/run/user/501/podman/podman.sock",
      "--identity",
      "/tmp/podman-machine-default",
    ]);
  });
  it("preserves a hot container after a source change, then recreates it when stopped", async () => {
    const workspaceDir = fs.realpathSync(tempDirs.make("openclaw-dood-"));
    const cfg = createSandboxConfig([], []);
    const params = containerParams(cfg, workspaceDir);
    vi.mocked(resolveDockerSourceNamespace).mockResolvedValue([
      { type: "bind", source: "/host/first", destination: workspaceDir, writable: true },
    ]);
    spawnState.containerExists = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);
    await harness.ensureSandboxContainer(params);
    const firstHash = spawnState.labelHash;
    spawnState.mounts = JSON.stringify([
      { Type: "bind", Source: "/host/first", Destination: "/workspace", RW: true },
    ]);
    registryMocks.readRegistryEntry.mockResolvedValue({
      containerName: "oc-test-shared",
      lastUsedAtMs: Date.now(),
      configHash: firstHash,
    });
    vi.mocked(resolveDockerSourceNamespace).mockResolvedValue([
      { type: "bind", source: "/host/second", destination: workspaceDir, writable: true },
    ]);
    spawnState.calls.length = 0;
    await expect(harness.ensureSandboxContainer(params)).rejects.toThrow(
      "Recreate first: openclaw sandbox recreate --all",
    );
    expectNoMutation();
    expect(spawnState.labelHash).toBe(firstHash);
    spawnState.inspectRunning = false;
    await harness.ensureSandboxContainer(params);
    expect(spawnState.calls.some((call) => call.args[0] === "rm")).toBe(true);
    expect(spawnState.labelHash).not.toBe(firstHash);
    expect(collectDockerFlagValues(calls("create")[0]?.args ?? [], "-v")).toContain(
      "/host/second:/workspace:z",
    );
  });

  it("preserves hot Podman tmpfs removal and replaces it only after stopping", async () => {
    const workspaceDir = tempDirs.make("openclaw-tmpfs-lifecycle-");
    const cfg = createSandboxConfig([], [], "rw");
    cfg.backend = "podman";
    cfg.docker.tmpfs = ["/workspace/cache:rw"];
    const params = podmanParams(cfg, workspaceDir);
    spawnState.containerExists = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);
    await harness.ensureSandboxContainer(params);
    const firstHash = spawnState.labelHash;
    spawnState.mounts = JSON.stringify([
      { Type: "bind", Source: workspaceDir, Destination: "/workspace", RW: true },
    ]);
    spawnState.tmpfs = { "/workspace/cache": "rw,nosuid,nodev" };
    cfg.docker.env = { CHANGED: "1" };
    await expect(harness.ensureSandboxContainer(params)).resolves.toBeDefined();
    cfg.docker.tmpfs = [];
    spawnState.calls.length = 0;
    await expect(harness.ensureSandboxContainer(params)).rejects.toThrow("Sandbox mounts changed");
    expectNoMutation();
    expect(spawnState.labelHash).toBe(firstHash);
    spawnState.inspectRunning = false;
    await harness.ensureSandboxContainer(params);
    const create = calls("create")[0];
    expect(create).toBeDefined();
    expect(collectDockerFlagValues(create!.args, "--tmpfs")).not.toContain("/workspace/cache:rw");
    expect(spawnState.labelHash).not.toBe(firstHash);
  });

  it("skips user binds that conflict with protected skill overlays for Podman", async () => {
    const workspaceDir = tempDirs.make("openclaw-docker-mounts-");
    const customRoot = tempDirs.make("openclaw-docker-mounts-");
    fs.mkdirSync(path.join(workspaceDir, "skills", "demo"), { recursive: true });
    const customMount = `${customRoot}:/workspace/skills:rw`;
    const cfg = createSandboxConfig([], [customMount]);
    cfg.backend = "podman";
    cfg.docker.workdir = "/workspace/.";
    cfg.docker.dangerouslyAllowExternalBindSources = true;
    prepareCreation();

    const createCall = await createPodman(cfg, workspaceDir);
    const bindArgs = collectDockerFlagValues(createCall.args, "-v");

    expect(createCall.command).toBe("podman");
    expect(bindArgs).not.toContain(customMount);
    expect(bindArgs).toContain(`${path.join(workspaceDir, "skills")}:/workspace/skills:ro,z`);
  });
});
