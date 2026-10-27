import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import "../../test-utils/prepare-compiled-subprocesses.js";
import { SANDBOX_DOCKER_EXPLICIT_ENV_POLICY_EPOCH } from "./config-hash.js";
import { SANDBOX_DOCKER_CREATE_ARGS_EPOCH } from "./constants.js";
import { createSandboxContainerTestHarness } from "./docker.create.test-helpers.js";
import { collectDockerFlagValues as flags } from "./test-args.js";
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
    ensureSandboxCreateCallForTest: createContainer,
    ensureSandboxContainer: ensure,
    resolveDockerSourceNamespace,
  } = harness;

  type Config = Parameters<typeof ensure>[0]["cfg"];
  const containerParams = (cfg: Config, workspaceDir = "/tmp/workspace") => ({
    scopeKey: "shared",
    workspaceDir,
    agentWorkspaceDir: workspaceDir,
    cfg,
  });
  const podmanParams = (cfg: Config, workspaceDir?: string) => ({
    ...containerParams(cfg, workspaceDir),
    engine: harness.PODMAN_SANDBOX_ENGINE,
  });
  const createPodman = (cfg: Config, workspaceDir: string) =>
    createContainer(podmanParams(cfg, workspaceDir));
  const workspace = () => {
    const workspaceDir = tempDirs.make("openclaw-docker-mounts-");
    const cfg = createSandboxConfig([], [`${workspaceDir}:/workspace:rw`]);
    return { workspaceDir, cfg, params: containerParams(cfg, workspaceDir) };
  };
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
  const recordContainer = (cfg: Config, entry: Record<string, unknown>) =>
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

  const hashInput = (cfg: Config, workspaceDir: string) => ({
    docker: cfg.docker,
    workspaceAccess: cfg.workspaceAccess,
    workspaceDir,
    agentWorkspaceDir: workspaceDir,
    mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
    createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
  });

  it("serializes concurrent provisioning", async () => {
    const { params } = workspace();
    prepareCreation(true);
    const [first, second] = await Promise.all([ensure(params), ensure(params)]);

    expect(first.currentConfig).toBe(true);
    expect(second).toEqual(first);
    expect(calls("create")).toHaveLength(1);
    expect(calls("start")).toHaveLength(1);
    expect(calls("image")).toHaveLength(0);
    expect(calls("create")[0]?.args).toContain("--pull=never");
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
      const workspaceDir = tempDirs.make("openclaw-docker-create-");
      const cfg = createSandboxConfig([], [`${workspaceDir}:/workspace:rw`]);
      cfg.docker.image = "example/custom:latest";
      prepareCreation(true);
      spawnState.createError = imageError || "container name is already in use";
      spawnState.imageError = imageError;

      await expect(
        harness.ensureSandboxContainer(containerParams(cfg, workspaceDir)),
      ).rejects.toThrow(message);

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
      const methods = [
        "readRegistryEntry",
        "updateRegistry",
        "completeSandboxRegistryReservation",
        "removeRegistryEntry",
      ] as const;
      for (const name of methods) {
        registryMocks[name].mockImplementation(registry[name]);
      }
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
            ensure({
              ...(backendId === "podman" ? { engine: harness.PODMAN_SANDBOX_ENGINE } : {}),
              ...containerParams(cfg, workspaceDir),
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
        for (const name of methods) {
          registryMocks[name].mockReset();
        }
      }
    },
  );

  it("uses the canonical non-shared scope for Docker names, labels, and registry identity", async () => {
    const { workspaceDir, cfg } = workspace();
    cfg.scope = "agent";
    prepareCreation(true);
    const scopeKey = `agent:poly:workspace:${"a".repeat(32)}`;

    const createCall = await createContainer({ cfg, workspaceDir, scopeKey });

    const containerName = createCall.args[createCall.args.indexOf("--name") + 1];
    expect(containerName).toMatch(/^oc-test-workspace-[a-f0-9]{32}$/);
    expect(createCall.args).toContain(`openclaw.sessionKey=${scopeKey}`);
    expect(registryMocks.updateRegistry.mock.calls.at(-1)?.[0]).toMatchObject({
      containerName,
      sessionKey: scopeKey,
    });
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

    const createCall = await createContainer({ cfg, workspaceDir });
    expect(createCall.args).toContain(`openclaw.configHash=${newHash}`);
    expect(createCall.args).not.toContain("--env");
    expect(createCall.envFileContents).toContain("GEMINI_API_KEY=dummy-gemini\n");
    expect(createCall.args.join(" ")).not.toContain("dummy-gemini");
    const envFile = flags(createCall.args, "--env-file")[0];
    expect(envFile).toBeDefined();
    expect(fs.existsSync(envFile!)).toBe(false);

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

    await expect(ensure(podmanParams(cfg, workspaceDir))).rejects.toThrow(
      "Install catatonit on the Podman engine host",
    );
    const creates = calls("create");
    expect(creates).toHaveLength(1);
    const create = creates[0]!;
    expect(create.args.filter((arg) => arg === "--init")).toHaveLength(1);
    expect(
      spawnState.calls.some((call) => ["start", "exec", "rm"].includes(call.args[0] ?? "")),
    ).toBe(false);
    expect(registryMocks.updateRegistry).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeState: "pending" }),
    );
    expect(registryMocks.completeSandboxRegistryReservation).not.toHaveBeenCalled();
    expect(registryMocks.removeRegistryEntry).not.toHaveBeenCalled();
    const envFile = flags(create.args, "--env-file")[0];
    expect(envFile).toBeDefined();
    expect(fs.existsSync(envFile!)).toBe(false);
  });

  it.each([false, true])("creates a rootless Podman workspace (Machine=%s)", async (machine) => {
    const workspaceDir = machine
      ? path.join(os.homedir(), "openclaw-podman-workspace")
      : "/tmp/workspace";
    const cfg = createSandboxConfig([], []);
    cfg.docker.user = "1001:1002";
    if (machine) {
      cfg.docker.binds = [`${workspaceDir}:/workspace:rw`];
      usePodmanMachine();
    }
    prepareCreation();

    const createCall = await createPodman(cfg, workspaceDir);

    expect(flags(createCall.args, "--userns")).toEqual(["keep-id:uid=1001,gid=1002"]);
    expect(flags(createCall.args, "--user")).toEqual(["1001:1002"]);
    expect(createCall.args).toEqual(
      expect.arrayContaining(["--http-proxy=false", "--init", "--read-only-tmpfs=true"]),
    );
    expect(flags(createCall.args, "--tmpfs")).toEqual(["/tmp", "/var/tmp"]);
    expect(flags(createCall.args, "-v")).toContain(`${workspaceDir}:/workspace:z`);
    const update = registryMocks.updateRegistry.mock.calls.at(-1)?.[0];
    expect(update?.backendId).toBe("podman");
    if (machine) {
      expect(createCall.globalArgs).toEqual([
        "--url",
        "ssh://core@127.0.0.1:60000/run/user/501/podman/podman.sock",
        "--identity",
        "/tmp/podman-machine-default",
      ]);
    } else {
      expect(update?.backendTarget).toEqual({ key: "local", globalArgs: [] });
    }
  });

  it.each([
    ["0", undefined, true, "5.0.0", /cannot use UID or GID 0/iu],
    ["1001:000", undefined, true, "5.0.0", /cannot use UID or GID 0/iu],
    ["node", undefined, true, "5.0.0", /must be a numeric UID or UID:GID/iu],
    ["1001:1002", undefined, true, "4.2.0", /requires Podman 4\.3 or newer/iu],
    [undefined, "all", false, "4.9.3", /GPU passthrough requires Podman 5\.0 or newer/iu],
  ] as const)(
    "rejects Podman user=%s gpus=%s rootless=%s version=%s",
    async (user, gpus, rootless, version, error) => {
      const cfg = createSandboxConfig([]);
      cfg.docker.user = user;
      cfg.docker.gpus = gpus;
      spawnState.podmanInfo = `${rootless}\tfalse\t\t${version}\n`;
      prepareCreation();
      await expect(ensure(podmanParams(cfg))).rejects.toThrow(error);
      expect(spawnState.calls).not.toContainEqual(
        expect.objectContaining({ command: "podman", args: expect.arrayContaining(["create"]) }),
      );
    },
  );

  it("refuses a local-to-Machine target change before inspecting the container", async () => {
    const cfg = createSandboxConfig([]);
    usePodmanMachine();
    recordContainer(cfg, {
      containerName: "oc-test-podman-shared",
      backendId: "podman",
      backendTarget: { key: "local", globalArgs: [] },
      lastUsedAtMs: 1,
    });
    await expect(ensure(podmanParams(cfg))).rejects.toThrow("active Podman connection changed");
    expect(calls("inspect")).toEqual([]);
    expectNoMutation();
    expect(registryMocks.removeRegistryEntry).not.toHaveBeenCalled();
  });

  it("recreates a missing recorded Podman target on the active engine", async () => {
    const cfg = createSandboxConfig([]);
    const containerName = "oc-test-podman-shared";
    const backendTarget = {
      key: `machine:${"a".repeat(32)}`,
      globalArgs: ["--url", "ssh://core@127.0.0.1:60001/run/user/501/podman/podman.sock"],
    };
    spawnState.containerExists = spawnState.inspectRunning = false;
    spawnState.inspectError =
      'Error: no container with name or ID "oc-test-podman-shared" found: no such container';
    recordContainer(cfg, {
      containerName,
      backendId: "podman",
      backendTarget,
      lastUsedAtMs: 1,
    });
    await expect(ensure(podmanParams(cfg))).resolves.toMatchObject({
      containerName,
      currentConfig: true,
    });
    expect(registryMocks.removeRegistryEntry).toHaveBeenCalledWith(containerName);
    expect(spawnState.calls).toContainEqual(
      expect.objectContaining({
        command: "podman",
        globalArgs: [],
        args: expect.arrayContaining(["create", "--name", containerName]),
      }),
    );
  });

  it("invalidates a Podman container when the same tmpfs list becomes explicit", async () => {
    const { workspaceDir, cfg } = workspace();
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

  it.each(["bind", "tmpfs"] as const)("preserves hot %s changes until stopped", async (kind) => {
    const workspaceDir = fs.realpathSync(tempDirs.make("openclaw-dood-"));
    const cfg = createSandboxConfig([], []);
    const params =
      kind === "tmpfs" ? podmanParams(cfg, workspaceDir) : containerParams(cfg, workspaceDir);
    const source = (value: string) =>
      vi
        .mocked(resolveDockerSourceNamespace)
        .mockResolvedValue([
          { type: "bind", source: value, destination: workspaceDir, writable: true },
        ]);
    if (kind === "bind") {
      source("/host/first");
    } else {
      cfg.backend = "podman";
      cfg.docker.tmpfs = ["/workspace/cache:rw"];
    }
    spawnState.containerExists = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);
    await ensure(params);
    const firstHash = spawnState.labelHash;
    spawnState.mounts = JSON.stringify([
      mount(kind === "bind" ? "/host/first" : workspaceDir, "/workspace"),
    ]);
    if (kind === "bind") {
      registryMocks.readRegistryEntry.mockResolvedValue({
        containerName: "oc-test-shared",
        lastUsedAtMs: Date.now(),
        configHash: firstHash,
      });
      source("/host/second");
    } else {
      spawnState.tmpfs = { "/workspace/cache": "rw,nosuid,nodev" };
      cfg.docker.env = { CHANGED: "1" };
      await expect(ensure(params)).resolves.toBeDefined();
      cfg.docker.tmpfs = [];
    }
    spawnState.calls.length = 0;
    await expect(ensure(params)).rejects.toThrow(
      kind === "bind"
        ? "Recreate first: openclaw sandbox recreate --all"
        : "Sandbox mounts changed",
    );
    expectNoMutation();
    expect(spawnState.labelHash).toBe(firstHash);
    spawnState.inspectRunning = false;
    await ensure(params);
    expect(spawnState.calls.some((call) => call.args[0] === "rm")).toBe(true);
    expect(spawnState.labelHash).not.toBe(firstHash);
    const create = calls("create")[0];
    expect(create).toBeDefined();
    if (kind === "bind") {
      expect(flags(create!.args, "-v")).toContain("/host/second:/workspace:z");
    } else {
      expect(flags(create!.args, "--tmpfs")).not.toContain("/workspace/cache:rw");
    }
  });

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
      const workspaceDir = fs.realpathSync(tempDirs.make("openclaw-skill-upgrade-"));
      fs.writeFileSync(path.join(workspaceDir, "work.txt"), "saved work");
      const cfg = createSandboxConfig([], [], "none");
      cfg.backend = backendId;
      if (scenario === "user read-only skill bind") {
        cfg.docker.binds = [`${workspaceDir}/previous:/workspace/skills:ro`];
      }
      const params = {
        ...containerParams(cfg, workspaceDir),
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
              ? "restricted dispatch requires"
              : "Sandbox mounts changed",
          );
          expectNoMutation();
          if (scenario === "restricted dispatch") {
            expect(registryMocks.updateRegistry).not.toHaveBeenCalled();
          }
          return;
        }
        await expect(ensure(params)).resolves.toMatchObject({ currentConfig: true });
      } finally {
        startedAt.mockRestore();
        persistent?.mockRestore();
      }
      expect(calls("rm")).toHaveLength(1);
      expect(flags(calls("create")[0]!.args, "-v")).toEqual(
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
    const bindArgs = flags(createCall.args, "-v");
    expect(createCall.command).toBe("podman");
    expect(bindArgs).not.toContain(customMount);
    expect(bindArgs).toContain(`${path.join(workspaceDir, "skills")}:/workspace/skills:ro,z`);
  });
});
