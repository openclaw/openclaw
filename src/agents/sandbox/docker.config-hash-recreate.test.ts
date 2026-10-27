import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../test-utils/prepare-compiled-subprocesses.js";
import { SANDBOX_DOCKER_EXPLICIT_ENV_POLICY_EPOCH } from "./config-hash.js";
import { SANDBOX_DOCKER_CREATE_ARGS_EPOCH } from "./constants.js";
import { createSandboxContainerTestHarness } from "./docker.create.test-helpers.js";
import { collectDockerFlagValues } from "./test-args.js";
import type { SandboxConfig } from "./types.js";
import {
  ensureReadOnlyWorkspaceSkillMountSources,
  SANDBOX_MOUNT_FORMAT_VERSION,
} from "./workspace-mounts.js";

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

  let workspaceDir: string;
  let cfg: SandboxConfig;
  beforeEach(() => {
    workspaceDir = fs.realpathSync(tempDirs.make("openclaw-container-recreate-"));
    cfg = createSandboxConfig([], []);
  });
  const containerParams = (config = cfg, workspace = workspaceDir) => ({
    scopeKey: "shared",
    workspaceDir: workspace,
    agentWorkspaceDir: workspace,
    cfg: config,
  });
  const podmanParams = () => ({
    ...containerParams(),
    engine: harness.PODMAN_SANDBOX_ENGINE,
  });
  const ensure = (params: Partial<Parameters<typeof harness.ensureSandboxContainer>[0]> = {}) =>
    harness.ensureSandboxContainer({ ...containerParams(), ...params });
  const createPodman = () => ensureSandboxCreateCallForTest(podmanParams());
  const calls = (operation: string) =>
    spawnState.calls.filter((call) => call.args[0] === operation);
  const mount = (Source: string, Destination: string, RW = true, Type = "bind") => ({
    Type,
    Source,
    Destination,
    RW,
  });
  const expectNoMutation = () => {
    expect(spawnState.calls.some((call) => ["rm", "create", "start"].includes(call.args[0]!))).toBe(
      false,
    );
  };
  const recordContainer = (config: SandboxConfig, entry: Record<string, unknown>) =>
    registryMocks.readRegistryEntry.mockResolvedValue({
      containerName: "oc-test-shared",
      sessionKey: "shared",
      createdAtMs: 1,
      lastUsedAtMs: 0,
      image: config.docker.image,
      ...entry,
    });
  const prepareCreation = (missing = false) => {
    spawnState.inspectRunning = false;
    if (missing) {
      spawnState.containerExists = false;
    }
    registryMocks.readRegistryEntry.mockResolvedValue(null);
  };

  const hashInput = (config: SandboxConfig, workspace: string) => ({
    docker: config.docker,
    workspaceAccess: config.workspaceAccess,
    workspaceDir: workspace,
    agentWorkspaceDir: workspace,
    mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
    createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
  });

  it("serializes provisioning and inspects each admitted container once", async () => {
    cfg = createSandboxConfig([], [`${workspaceDir}:/workspace:rw`]);
    prepareCreation(true);

    const params = containerParams();
    const [first, second] = await Promise.all([ensure(params), ensure(params)]);

    expect(first).toMatchObject({
      containerName: "oc-test-shared",
      containerId: "c".repeat(64),
      configHash: expect.any(String),
      currentConfig: true,
    });
    expect(second).toEqual(first);
    expect(calls("create")).toHaveLength(1);
    expect(calls("start")).toHaveLength(1);
    expect(calls("inspect")).toHaveLength(2);
    expect(calls("image")).toHaveLength(0);
    expect(calls("create")[0]?.args).toContain("--pull=never");
  });

  it.each(["docker", "podman"] as const)(
    "%s publishes allocation once through the backend entry point, including warm reuse",
    async (backendId) => {
      const target = await import("./docker-persistent-target.js");
      const capture = vi
        .spyOn(target, "captureDockerPersistentTarget")
        .mockResolvedValue(undefined);
      const { createSandboxBackend, registerSandboxBackend } = await import("./backend.js");
      try {
        cfg.backend = backendId;
        prepareCreation(true);
        const params = { ...containerParams(), sessionKey: "shared" };
        const first = await createSandboxBackend(params);
        expect(calls("info")).toHaveLength(backendId === "podman" ? 1 : 0);
        expect(registryMocks.updateRegistry).toHaveBeenCalledTimes(1);
        const published = registryMocks.updateRegistry.mock.calls[0]?.[0];
        expect(published).toMatchObject({
          containerName: first.runtimeId,
          backendId,
          sessionKey: "shared",
          workspaceDir,
          configHash: expect.any(String),
          image: cfg.docker.image,
        });
        registryMocks.readRegistryEntry.mockResolvedValue(published);
        const second = await createSandboxBackend(params);
        expect(calls("info")).toHaveLength(backendId === "podman" ? 2 : 0);
        expect(second.runtimeId).toBe(first.runtimeId);
        expect(registryMocks.updateRegistry).toHaveBeenCalledTimes(2);
        expect(calls("create")).toHaveLength(1);
        expect(calls("start")).toHaveLength(1);

        // An override of a built-in ID still relies on the generic publisher.
        const restore = registerSandboxBackend(backendId, async () => first);
        try {
          await createSandboxBackend(params);
          expect(registryMocks.updateRegistry).toHaveBeenCalledTimes(3);
        } finally {
          restore();
        }
      } finally {
        capture.mockRestore();
      }
    },
  );

  it("retains managed allocation custody and stamps activity after provisioning", async () => {
    prepareCreation(true);
    using now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const writes: Array<{ createdAtMs: number; lastUsedAtMs: number }> = [];
    registryMocks.updateRegistry.mockImplementation(async (entry) => {
      writes.push({ createdAtMs: entry.createdAtMs, lastUsedAtMs: entry.lastUsedAtMs });
      if (writes.length === 1) {
        expect(calls("create")).toHaveLength(0);
        now.mockReturnValue(10_000);
      } else {
        expect(calls("start")).toHaveLength(1);
      }
    });
    await ensure({
      workspaceSource: "managed-worktree",
    });
    expect(writes).toEqual([
      { createdAtMs: 1000, lastUsedAtMs: 1000 },
      { createdAtMs: 1000, lastUsedAtMs: 10_000 },
    ]);
  });

  it.each([
    [
      "No such image: example/custom:latest",
      "Sandbox image not found: example/custom:latest. Build or pull it first.",
    ],
    ["", "container name is already in use"],
  ])(
    "diagnoses failed Docker creation without starting a container (%s)",
    async (imageError, message) => {
      cfg = createSandboxConfig([], [`${workspaceDir}:/workspace:rw`]);
      cfg.docker.image = "example/custom:latest";
      prepareCreation(true);
      spawnState.createError = imageError || "container name is already in use";
      spawnState.imageError = imageError;

      await expect(ensure()).rejects.toThrow(message);

      expect(calls("create")).toHaveLength(1);
      expect(calls("image")).toHaveLength(1);
      expect(calls("start")).toHaveLength(0);
    },
  );

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
          const stateWorkspaceDir = state.workspaceDir;
          const retainedWorkspaceDir = state.path("retained-workspace");
          fs.mkdirSync(retainedWorkspaceDir);
          const stateConfig = createSandboxConfig([], []);
          stateConfig.backend = backendId;
          stateConfig.docker.setupCommand = "echo setup";
          const containerName = backendId === "podman" ? "oc-test-podman-shared" : "oc-test-shared";
          await registry.updateRegistry({
            containerName,
            backendId,
            ...(backendId === "podman" ? { backendTarget: { key: "local", globalArgs: [] } } : {}),
            sessionKey: "shared",
            workspaceDir: retainedWorkspaceDir,
            createdAtMs: 1,
            lastUsedAtMs: 1,
            image: stateConfig.docker.image,
            configHash: "stale-hash",
            runtimeState: "ready",
          });
          spawnState.inspectRunning = false;
          spawnState.labelHash = "stale-hash";

          await expect(
            ensure({
              ...(backendId === "podman" ? { engine: harness.PODMAN_SANDBOX_ENGINE } : {}),
              ...containerParams(stateConfig, stateWorkspaceDir),
            }),
          ).resolves.toMatchObject({
            containerName,
            currentConfig: true,
          });

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
    cfg = createSandboxConfig([], [`${workspaceDir}:/workspace:rw`]);
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

  it("recreates shared container when previously filtered explicit env becomes allowed", async () => {
    cfg = createSandboxConfig(["1.1.1.1"], undefined, "rw", {
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

    const registryUpdate = registryMocks.updateRegistry.mock.calls.at(-1)?.[0];
    expect(registryUpdate?.configHash).toBe(newHash);
  });

  it("reports a missing Podman init dependency without weakening or completing provisioning", async () => {
    cfg = createSandboxConfig([], [], "rw", {});
    cfg.backend = "podman";
    cfg.docker.setupCommand = "echo setup-must-not-run";
    prepareCreation(true);
    spawnState.createError =
      'Error: lookup init binary: exec: "catatonit": executable file not found in $PATH\n';

    const error = await ensure(podmanParams()).catch((caught: unknown) => caught);

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
    cfg.docker.user = "1001:1002";
    prepareCreation();

    const createCall = await createPodman();

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
      cfg = createSandboxConfig([], [`${workspaceDir}:/workspace:rw`]);
      cfg.docker.user = user;
      cfg.docker.gpus = gpus;
      spawnState.podmanInfo = `${rootless}\tfalse\t\t${version}\n`;
      prepareCreation();
      await expect(ensure(podmanParams())).rejects.toThrow(error);
      expect(spawnState.calls).not.toContainEqual(
        expect.objectContaining({ command: "podman", args: expect.arrayContaining(["create"]) }),
      );
    },
  );

  it("rejects a preselected Podman target that changed before allocation", async () => {
    await expect(
      ensure({
        ...podmanParams(),
        podmanTarget: { key: "socket:previous", globalArgs: ["--url", "unix:///previous.sock"] },
      }),
    ).rejects.toThrow("active Podman connection changed");
    expect(calls("info")).toHaveLength(1);
    expect(calls("inspect")).toHaveLength(0);
    expectNoMutation();
  });

  it.each(["changed", "missing", "unreachable"] as const)(
    "handles a recorded Podman target that is %s",
    async (state) => {
      cfg = createSandboxConfig([], [`${workspaceDir}:/workspace:rw`]);
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
      const operation = ensure(podmanParams());
      const createCall = expect.objectContaining({
        command: "podman",
        globalArgs: [],
        args: expect.arrayContaining(["create", "--name", containerName]),
      });
      if (state === "missing") {
        await expect(operation).resolves.toMatchObject({
          containerName,
          containerId: "c".repeat(64),
          currentConfig: true,
          configHash: expect.any(String),
        });
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
    cfg = createSandboxConfig([], [`${workspaceDir}:/workspace:rw`]);
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
      ensure({
        ...podmanParams(),
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
    cfg = createSandboxConfig([], [`${workspaceDir}:/workspace:rw`]);
    workspaceDir = path.join(os.homedir(), "openclaw-podman-workspace");
    cfg.docker.binds = [`${workspaceDir}:/workspace:rw`];
    usePodmanMachine();
    prepareCreation();

    const createCall = await createPodman();

    expect(createCall.command).toBe("podman");
    expect(createCall.globalArgs).toEqual([
      "--url",
      "ssh://core@127.0.0.1:60000/run/user/501/podman/podman.sock",
      "--identity",
      "/tmp/podman-machine-default",
    ]);
  });
  it.each(["Docker source change", "Podman tmpfs removal"])(
    "preserves hot %s and replaces it only after stopping",
    async (change) => {
      const podman = change === "Podman tmpfs removal";
      const source = podman ? workspaceDir : "/host/first";
      const namespace = (mountSource: string) =>
        vi
          .mocked(resolveDockerSourceNamespace)
          .mockResolvedValue([
            { type: "bind", source: mountSource, destination: workspaceDir, writable: true },
          ]);
      if (podman) {
        cfg.backend = "podman";
        cfg.docker.tmpfs = ["/workspace/cache:rw"];
      } else {
        namespace(source);
      }
      const params = podman ? podmanParams() : containerParams();
      prepareCreation(true);
      await ensure(params);
      const firstHash = spawnState.labelHash;
      spawnState.mounts = JSON.stringify([mount(source, "/workspace")]);
      if (podman) {
        spawnState.tmpfs = { "/workspace/cache": "rw,nosuid,nodev" };
        cfg.docker.env = { CHANGED: "1" };
        await expect(ensure(params)).resolves.toBeDefined();
        cfg.docker.tmpfs = [];
      } else {
        recordContainer(cfg, { lastUsedAtMs: Date.now(), configHash: firstHash });
        namespace("/host/second");
      }
      spawnState.calls.length = 0;
      await expect(ensure(params)).rejects.toThrow(
        podman ? "Sandbox mounts changed" : "Recreate first: openclaw sandbox recreate --all",
      );
      expectNoMutation();
      expect(spawnState.labelHash).toBe(firstHash);
      spawnState.inspectRunning = false;
      await ensure(params);
      expect(calls("rm")).not.toHaveLength(0);
      expect(spawnState.labelHash).not.toBe(firstHash);
      const create = calls("create")[0];
      expect(create).toBeDefined();
      if (podman) {
        expect(collectDockerFlagValues(create!.args, "--tmpfs")).not.toContain(
          "/workspace/cache:rw",
        );
      } else {
        expect(collectDockerFlagValues(create!.args, "-v")).toContain("/host/second:/workspace:z");
      }
    },
  );

  it.each([
    { scenario: "Docker restart", backendId: "docker", replace: true },
    { scenario: "Podman restart", backendId: "podman", replace: true },
    { scenario: "current Gateway use", backendId: "docker", replace: false },
    { scenario: "writable root", backendId: "docker", replace: false },
    { scenario: "user source change", backendId: "docker", replace: false },
    { scenario: "persistent custody", backendId: "docker", replace: false },
    { scenario: "restricted dispatch", backendId: "docker", replace: false },
    { scenario: "image volume", backendId: "docker", replace: false },
    { scenario: "writable skill bind", backendId: "docker", replace: false },
    { scenario: "user read-only skill bind", backendId: "docker", replace: false },
  ] as const)(
    "handles protected skill mount upgrades with $scenario",
    async ({ scenario, backendId, replace }) => {
      fs.writeFileSync(path.join(workspaceDir, "work.txt"), "saved work");
      cfg = createSandboxConfig([], [], "none");
      cfg.backend = backendId;
      if (scenario === "user read-only skill bind") {
        cfg.docker.binds = [`${workspaceDir}/previous:/workspace/skills:ro`];
      }
      const params = {
        ...containerParams(),
        requireCurrentConfig: scenario === "restricted dispatch",
        ...(backendId === "podman" ? { engine: harness.PODMAN_SANDBOX_ENGINE } : {}),
      };
      prepareCreation(true);
      await ensure(params);
      spawnState.mounts = JSON.stringify([
        mount(
          scenario === "user source change" ? `${workspaceDir}/previous` : workspaceDir,
          "/workspace",
        ),
        ...(scenario === "image volume" ? [mount("/volume", "/data", true, "volume")] : []),
        ...(scenario === "writable skill bind"
          ? [mount(`${workspaceDir}/skills`, "/workspace/skills")]
          : []),
        ...(scenario === "user read-only skill bind"
          ? [mount(`${workspaceDir}/previous`, "/workspace/skills", false)]
          : []),
      ]);
      spawnState.readOnlyRoot = scenario !== "writable root";
      recordContainer(cfg, {
        backendId,
        ...(backendId === "podman" ? { backendTarget: { key: "local", globalArgs: [] } } : {}),
        lastUsedAtMs: Date.now() - 2_000,
        configHash: spawnState.labelHash,
      });
      // The old release omitted absent roots; the upgrade prepares them before admission.
      await ensureReadOnlyWorkspaceSkillMountSources({
        ...params,
        workdir: cfg.docker.workdir,
        workspaceAccess: cfg.workspaceAccess,
      });
      const startedAt = vi
        .spyOn(performance, "timeOrigin", "get")
        .mockReturnValue(Date.now() - (scenario === "current Gateway use" ? 60_000 : 100));
      const persistent =
        scenario === "persistent custody"
          ? vi
              .spyOn(await import("./persistent-exec.js"), "hasSandboxPersistentExecCustody")
              .mockResolvedValue(true)
          : undefined;
      spawnState.calls.length = 0;
      registryMocks.updateRegistry.mockClear();
      try {
        if (!replace) {
          await expect(ensure(params)).rejects.toThrow(
            scenario === "restricted dispatch"
              ? "restricted dispatch requires the current container config"
              : "Sandbox mounts changed",
          );
          expectNoMutation();
          expect(registryMocks.updateRegistry).not.toHaveBeenCalled();
          return;
        }
        await expect(ensure(params)).resolves.toMatchObject({
          currentConfig: true,
        });
      } finally {
        startedAt.mockRestore();
        persistent?.mockRestore();
      }
      expect(calls("rm")).toHaveLength(1);
      expect(collectDockerFlagValues(calls("create")[0]!.args, "-v")).toEqual(
        expect.arrayContaining([
          `${workspaceDir}:/workspace:z`,
          `${workspaceDir}/skills:/workspace/skills:ro,z`,
          `${workspaceDir}/.agents/skills:/workspace/.agents/skills:ro,z`,
        ]),
      );
      expect(fs.readFileSync(path.join(workspaceDir, "work.txt"), "utf8")).toBe("saved work");
    },
  );

  it("skips user binds that conflict with protected skill overlays for Podman", async () => {
    const customRoot = tempDirs.make("openclaw-docker-mounts-");
    fs.mkdirSync(path.join(workspaceDir, "skills", "demo"), { recursive: true });
    const customMount = `${customRoot}:/workspace/skills:rw`;
    cfg = createSandboxConfig([], [customMount]);
    cfg.backend = "podman";
    cfg.docker.workdir = "/workspace/.";
    cfg.docker.dangerouslyAllowExternalBindSources = true;
    prepareCreation();
    const createCall = await createPodman();
    const bindArgs = collectDockerFlagValues(createCall.args, "-v");
    expect(createCall.command).toBe("podman");
    expect(bindArgs).not.toContain(customMount);
    expect(bindArgs).toContain(`${path.join(workspaceDir, "skills")}:/workspace/skills:ro,z`);
  });
});
