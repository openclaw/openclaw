import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SANDBOX_DOCKER_EXPLICIT_ENV_POLICY_EPOCH } from "./config-hash.js";
import { SANDBOX_DOCKER_CREATE_ARGS_EPOCH } from "./constants.js";
import { createSandboxContainerTestHarness } from "./docker.create.test-helpers.js";
import { collectDockerFlagValues } from "./test-args.js";
import { SANDBOX_MOUNT_FORMAT_VERSION } from "./workspace-mounts.js";

describe("ensureSandboxContainer config-hash recreation", () => {
  const harness = createSandboxContainerTestHarness();
  const {
    spawnState,
    registryMocks,
    runtimeMocks,
    tempDirs,
    usePodmanMachine,
    createSandboxConfig,
    computeTestSandboxHash,
    ensureSandboxCreateCallForTest,
  } = harness;

  it("serializes concurrent provisioning for one container", async () => {
    const workspaceDir = tempDirs.make("openclaw-docker-mounts-");
    const cfg = createSandboxConfig([], [`${workspaceDir}:/workspace:rw`]);
    spawnState.containerExists = false;
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    const params = {
      scopeKey: "shared",
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      cfg,
    };
    const [first, second] = await Promise.all([
      harness.ensureSandboxContainer(params),
      harness.ensureSandboxContainer(params),
    ]);

    expect(first).toEqual({ containerName: "oc-test-shared", containerId: "c".repeat(64) });
    expect(second).toEqual(first);
    expect(spawnState.calls.filter((call) => call.args[0] === "create")).toHaveLength(1);
    expect(spawnState.calls.filter((call) => call.args[0] === "start")).toHaveLength(1);
    expect(registryMocks.updateRegistry).toHaveBeenCalledTimes(2);
  });

  it("uses the canonical non-shared scope for Docker names, labels, and registry identity", async () => {
    const workspaceDir = tempDirs.make("openclaw-docker-mounts-");
    const cfg = createSandboxConfig([], [`${workspaceDir}:/workspace:rw`]);
    cfg.scope = "agent";
    spawnState.containerExists = false;
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);
    const scopeKey = `agent:poly:workspace:${"a".repeat(32)}`;

    const createCall = await ensureSandboxCreateCallForTest({
      cfg,
      workspaceDir,
      scopeKey,
    });

    const containerName = createCall.args[createCall.args.indexOf("--name") + 1];
    expect(containerName).toMatch(/^oc-test-workspace-[a-f0-9]{32}$/);
    expect(createCall.args).toContain(`openclaw.sessionKey=${scopeKey}`);
    expect(registryMocks.updateRegistry.mock.calls.at(-1)?.[0]).toMatchObject({
      containerName,
      sessionKey: scopeKey,
    });
  });

  it.each(["docker", "podman"] as const)(
    "delivers configured %s create environment without exposing values in process arguments",
    async (backend) => {
      const sentinel = "synthetic-container-create-transport-value";
      const cfg = createSandboxConfig([], undefined, "rw", { CONFIGURED_VALUE: sentinel });
      cfg.backend = backend;
      spawnState.containerExists = false;
      registryMocks.readRegistryEntry.mockResolvedValue(null);

      const createCall = await ensureSandboxCreateCallForTest({
        cfg,
        ...(backend === "podman" ? { engine: harness.PODMAN_SANDBOX_ENGINE } : {}),
      });

      expect(createCall.args.join(" ")).not.toContain(sentinel);
      expect(createCall.envFileContents).toContain(`CONFIGURED_VALUE=${sentinel}\n`);
      expect(createCall.envFileContents).toContain("OPENCLAW_CLI=1\n");
      const envFile = collectDockerFlagValues(createCall.args, "--env-file")[0];
      expect(envFile).toBeDefined();
      expect(fs.existsSync(envFile!)).toBe(false);
    },
  );

  it("recreates shared container when array-order change alters hash", async () => {
    // Docker flag order is part of the runtime contract, so order-sensitive
    // config changes must invalidate a shared container.
    const workspaceDir = tempDirs.make("openclaw-docker-mounts-");
    const oldCfg = createSandboxConfig(["1.1.1.1", "8.8.8.8"], [`${workspaceDir}:/workspace:rw`]);
    const newCfg = createSandboxConfig(["8.8.8.8", "1.1.1.1"], [`${workspaceDir}:/workspace:rw`]);

    const oldHash = await computeTestSandboxHash({
      docker: oldCfg.docker,
      workspaceAccess: oldCfg.workspaceAccess,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
    });
    const newHash = await computeTestSandboxHash({
      docker: newCfg.docker,
      workspaceAccess: newCfg.workspaceAccess,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
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

    const { containerName } = await harness.ensureSandboxContainer({
      scopeKey: "shared",
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      cfg: newCfg,
    });

    expect(containerName).toBe("oc-test-shared");
    const dockerCalls = spawnState.calls.filter((call) => call.command === "docker");
    expect(
      dockerCalls.some(
        (call) => call.args[0] === "rm" && call.args[1] === "-f" && call.args[2] === "c".repeat(64),
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

  it.each(["create-args", "private-workspace-mount"] as const)(
    "recreates a cold container when the %s format changes",
    async (format) => {
      const workspaceDir = tempDirs.make("openclaw-docker-mounts-");
      const cfg = createSandboxConfig([], [], "none", {});
      const hashInput = {
        docker: cfg.docker,
        dockerEnvPolicyEpoch: harness.resolveDockerEnvPolicyEpoch(cfg.docker.env),
        workspaceAccess: cfg.workspaceAccess,
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      };
      const oldHash = await computeTestSandboxHash({
        ...hashInput,
        createArgsEpoch: format === "create-args" ? "pre-init" : SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
        mountFormatVersion: format === "private-workspace-mount" ? 3 : SANDBOX_MOUNT_FORMAT_VERSION,
      });
      const newHash = await computeTestSandboxHash({
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
      expect(createCall.args).toContain(`${workspaceDir}:/workspace:z`);
    },
  );

  it("keeps a hot pre-init container running and emits the recreate hint", async () => {
    const workspaceDir = tempDirs.make("openclaw-docker-mounts-");
    spawnState.mounts = JSON.stringify([
      { Type: "bind", Source: workspaceDir, Destination: "/workspace", RW: true },
    ]);
    const cfg = createSandboxConfig([], [`${workspaceDir}:/workspace:rw`], "rw", {});
    const oldHash = await computeTestSandboxHash({
      docker: cfg.docker,
      dockerEnvPolicyEpoch: harness.resolveDockerEnvPolicyEpoch(cfg.docker.env),
      workspaceAccess: cfg.workspaceAccess,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      createArgsEpoch: "pre-init",
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

    await harness.ensureSandboxContainer({
      scopeKey: "shared",
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
    const workspaceDir = tempDirs.make("openclaw-docker-mounts-");
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
      harness.ensureSandboxContainer({
        scopeKey: "shared",
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
    const workspaceDir = tempDirs.make("openclaw-docker-mounts-");
    const cfg = createSandboxConfig(["1.1.1.1"], undefined, "rw", {
      LANG: "C.UTF-8",
      GEMINI_API_KEY: "dummy-gemini",
    });
    cfg.docker.binds = [`${workspaceDir}:/workspace:rw`];

    const oldHash = await computeTestSandboxHash({
      docker: cfg.docker,
      workspaceAccess: cfg.workspaceAccess,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
    });
    const newHash = await computeTestSandboxHash({
      docker: cfg.docker,
      dockerEnvPolicyEpoch: SANDBOX_DOCKER_EXPLICIT_ENV_POLICY_EPOCH,
      workspaceAccess: cfg.workspaceAccess,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
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
    expect(createCall.args).not.toContain("--env");
    expect(createCall.envFileContents).toContain("LANG=C.UTF-8\n");
    expect(createCall.envFileContents).toContain("GEMINI_API_KEY=dummy-gemini\n");

    const registryUpdate = registryMocks.updateRegistry.mock.calls.at(-1)?.[0];
    expect(registryUpdate?.configHash).toBe(newHash);
  });

  it("reports a missing Podman init dependency without weakening or completing provisioning", async () => {
    const workspaceDir = tempDirs.make("openclaw-podman-init-");
    const cfg = createSandboxConfig([], [], "rw", {});
    cfg.backend = "podman";
    cfg.docker.setupCommand = "echo setup-must-not-run";
    spawnState.containerExists = false;
    spawnState.inspectRunning = false;
    spawnState.createError =
      'Error: lookup init binary: exec: "catatonit": executable file not found in $PATH\n';
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    const error = await harness
      .ensureSandboxContainer({
        engine: harness.PODMAN_SANDBOX_ENGINE,
        scopeKey: "shared",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        cfg,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: expect.stringContaining("Install catatonit on the Podman engine host"),
      code: 125,
      stderr: Buffer.from(spawnState.createError),
    });
    const creates = spawnState.calls.filter((call) => call.args[0] === "create");
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
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    const createCall = await ensureSandboxCreateCallForTest({
      cfg,
      workspaceDir,
      engine: harness.PODMAN_SANDBOX_ENGINE,
    });

    expect(createCall.command).toBe("podman");
    expect(collectDockerFlagValues(createCall.args, "--userns")).toEqual([
      "keep-id:uid=1001,gid=1002",
    ]);
    expect(collectDockerFlagValues(createCall.args, "--user")).toEqual(["1001:1002"]);
    expect(createCall.args).toContain("--http-proxy=false");
    expect(createCall.args).toContain("--init");
    expect(createCall.args).toContain("--read-only-tmpfs=true");
    expect(collectDockerFlagValues(createCall.args, "--tmpfs")).toEqual(["/tmp", "/var/tmp"]);
    expect(collectDockerFlagValues(createCall.args, "-v")).toContain(
      `${workspaceDir}:/workspace:z`,
    );
    expect(registryMocks.updateRegistry.mock.calls.at(-1)?.[0]?.backendId).toBe("podman");
    expect(registryMocks.updateRegistry.mock.calls.at(-1)?.[0]?.backendTarget).toEqual({
      key: "local",
      globalArgs: [],
    });
  });

  it("uses the workspace owner without keep-id for rootful Podman", async () => {
    const cfg = createSandboxConfig([]);
    cfg.docker.user = "1001:1002";
    spawnState.podmanInfo = "false\tfalse\t\t5.0.0\n";
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    const createCall = await ensureSandboxCreateCallForTest({
      cfg,
      engine: harness.PODMAN_SANDBOX_ENGINE,
    });

    expect(collectDockerFlagValues(createCall.args, "--user")).toEqual(["1001:1002"]);
    expect(collectDockerFlagValues(createCall.args, "--userns")).toEqual([]);
  });

  it.each([{ user: "0" }, { user: "00:1002" }, { user: "1001:000" }])(
    "rejects zero-valued rootless Podman user $user",
    async ({ user }) => {
      const cfg = createSandboxConfig([]);
      cfg.docker.user = user;
      spawnState.inspectRunning = false;
      registryMocks.readRegistryEntry.mockResolvedValue(null);

      await expect(
        harness.ensureSandboxContainer({
          engine: harness.PODMAN_SANDBOX_ENGINE,
          scopeKey: "shared",
          workspaceDir: "/tmp/workspace",
          agentWorkspaceDir: "/tmp/workspace",
          cfg,
        }),
      ).rejects.toThrow(/cannot use UID or GID 0/iu);

      expect(spawnState.calls).not.toContainEqual(
        expect.objectContaining({
          command: "podman",
          args: expect.arrayContaining(["create"]),
        }),
      );
    },
  );

  it("rejects Podman versions without mapped keep-id support", async () => {
    const cfg = createSandboxConfig([]);
    cfg.docker.user = "1001:1002";
    spawnState.podmanInfo = "true\tfalse\t\t4.2.0\n";
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    await expect(
      harness.ensureSandboxContainer({
        engine: harness.PODMAN_SANDBOX_ENGINE,
        scopeKey: "shared",
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/workspace",
        cfg,
      }),
    ).rejects.toThrow(/requires Podman 4\.3 or newer/iu);
  });

  it("rejects Podman GPU passthrough before Podman 5", async () => {
    const cfg = createSandboxConfig([]);
    cfg.docker.gpus = "all";
    spawnState.podmanInfo = "false\tfalse\t\t4.9.3\n";
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    await expect(
      harness.ensureSandboxContainer({
        engine: harness.PODMAN_SANDBOX_ENGINE,
        scopeKey: "shared",
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/workspace",
        cfg,
      }),
    ).rejects.toThrow(/GPU passthrough requires Podman 5\.0 or newer/iu);
  });

  it("rejects nonnumeric users for rootless Podman keep-id", async () => {
    const cfg = createSandboxConfig([]);
    cfg.docker.user = "node";
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    await expect(
      harness.ensureSandboxContainer({
        engine: harness.PODMAN_SANDBOX_ENGINE,
        scopeKey: "shared",
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/workspace",
        cfg,
      }),
    ).rejects.toThrow(/must be a numeric UID or UID:GID/iu);

    expect(spawnState.calls).not.toContainEqual(
      expect.objectContaining({
        command: "podman",
        args: expect.arrayContaining(["create"]),
      }),
    );
  });

  it("rejects a Podman runtime recorded for a different engine target", async () => {
    const cfg = createSandboxConfig([]);
    usePodmanMachine();
    registryMocks.readRegistryEntry.mockResolvedValue({
      containerName: "oc-test-podman-shared",
      backendId: "podman",
      backendTarget: { key: "local", globalArgs: [] },
      sessionKey: "shared",
      createdAtMs: 1,
      lastUsedAtMs: 1,
      image: cfg.docker.image,
    });

    await expect(
      harness.ensureSandboxContainer({
        engine: harness.PODMAN_SANDBOX_ENGINE,
        scopeKey: "shared",
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/workspace",
        cfg,
      }),
    ).rejects.toThrow(/active Podman connection changed/u);
    expect(registryMocks.removeRegistryEntry).not.toHaveBeenCalled();
    expect(spawnState.calls).not.toContainEqual(
      expect.objectContaining({
        command: "podman",
        globalArgs: [],
        args: expect.arrayContaining(["inspect"]),
      }),
    );
  });

  it("recovers when a Podman target changed after the recorded runtime disappeared", async () => {
    const cfg = createSandboxConfig([]);
    spawnState.containerExists = false;
    spawnState.inspectRunning = false;
    spawnState.inspectError =
      'Error: no container with name or ID "oc-test-podman-shared" found: no such container';
    registryMocks.readRegistryEntry.mockResolvedValue({
      containerName: "oc-test-podman-shared",
      backendId: "podman",
      backendTarget: {
        key: `machine:${"a".repeat(32)}`,
        globalArgs: ["--url", "ssh://core@127.0.0.1:60001/run/user/501/podman/podman.sock"],
      },
      sessionKey: "shared",
      createdAtMs: 1,
      lastUsedAtMs: 1,
      image: cfg.docker.image,
    });

    await expect(
      harness.ensureSandboxContainer({
        engine: harness.PODMAN_SANDBOX_ENGINE,
        scopeKey: "shared",
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/workspace",
        cfg,
      }),
    ).resolves.toEqual({ containerName: "oc-test-podman-shared", containerId: "c".repeat(64) });

    expect(registryMocks.removeRegistryEntry).toHaveBeenCalledWith("oc-test-podman-shared");
    expect(spawnState.calls).toContainEqual(
      expect.objectContaining({
        command: "podman",
        globalArgs: [],
        args: expect.arrayContaining(["create", "--name", "oc-test-podman-shared"]),
      }),
    );
  });

  it("preserves a Podman registry entry when its recorded target is unreachable", async () => {
    const cfg = createSandboxConfig([]);
    spawnState.inspectError = "Error: unable to connect to Podman socket: connection refused";
    registryMocks.readRegistryEntry.mockResolvedValue({
      containerName: "oc-test-podman-shared",
      backendId: "podman",
      backendTarget: {
        key: `machine:${"a".repeat(32)}`,
        globalArgs: ["--url", "ssh://core@127.0.0.1:60001/run/user/501/podman/podman.sock"],
      },
      sessionKey: "shared",
      createdAtMs: 1,
      lastUsedAtMs: 1,
      image: cfg.docker.image,
    });

    await expect(
      harness.ensureSandboxContainer({
        engine: harness.PODMAN_SANDBOX_ENGINE,
        scopeKey: "shared",
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/workspace",
        cfg,
      }),
    ).rejects.toThrow(/unable to connect to Podman socket/iu);

    expect(registryMocks.removeRegistryEntry).not.toHaveBeenCalled();
    expect(spawnState.calls).not.toContainEqual(
      expect.objectContaining({
        command: "podman",
        globalArgs: [],
        args: expect.arrayContaining(["create", "--name", "oc-test-podman-shared"]),
      }),
    );
  });

  it("uses collision-safe Docker name truncation for a long container prefix", async () => {
    const cfg = createSandboxConfig([]);
    cfg.scope = "session";
    cfg.docker.containerPrefix = "x".repeat(56);
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    const createCall = await ensureSandboxCreateCallForTest({
      cfg,
      scopeKey: "agent:first:session",
    });
    const containerName = collectDockerFlagValues(createCall.args, "--name")[0];

    expect(containerName).toHaveLength(63);
    expect(containerName).toMatch(/^x{50}-[a-f0-9]{12}$/);
  });

  it("preserves distinct session suffixes with a long Podman container prefix", async () => {
    const cfg = createSandboxConfig([]);
    cfg.scope = "session";
    cfg.docker.containerPrefix = "x".repeat(56);
    cfg.docker.user = undefined;
    spawnState.containerExists = false;
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    const firstCreate = await ensureSandboxCreateCallForTest({
      cfg,
      scopeKey: "agent:first:session",
      engine: harness.PODMAN_SANDBOX_ENGINE,
    });
    const firstName = collectDockerFlagValues(firstCreate.args, "--name")[0];

    spawnState.calls.length = 0;
    spawnState.containerExists = false;
    const secondCreate = await ensureSandboxCreateCallForTest({
      cfg,
      scopeKey: "agent:second:session",
      engine: harness.PODMAN_SANDBOX_ENGINE,
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
      engine: harness.PODMAN_SANDBOX_ENGINE,
    });

    expect(createCall.args).toContain("--init");
  });

  it("rejects a workdir whose managed workspace bind would cover Podman init", async () => {
    const cfg = createSandboxConfig([]);
    cfg.docker.workdir = "/run";
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    await expect(
      ensureSandboxCreateCallForTest({ cfg, engine: harness.PODMAN_SANDBOX_ENGINE }),
    ).rejects.toThrow("would cover Podman's init path");
  });

  it("omits the default /run tmpfs for writable-root Podman sandboxes", async () => {
    const cfg = createSandboxConfig([]);
    cfg.docker.readOnlyRoot = false;
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    const createCall = await ensureSandboxCreateCallForTest({
      cfg,
      engine: harness.PODMAN_SANDBOX_ENGINE,
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
      ensureSandboxCreateCallForTest({ cfg, engine: harness.PODMAN_SANDBOX_ENGINE }),
    ).rejects.toThrow("would cover Podman's init path");
  });

  it("invalidates a Podman container when the same tmpfs list becomes explicit", async () => {
    const workspaceDir = tempDirs.make("openclaw-docker-mounts-");
    const cfg = createSandboxConfig([], [`${workspaceDir}:/workspace:rw`]);
    const genericHash = await computeTestSandboxHash({
      docker: cfg.docker,
      dockerEnvPolicyEpoch: harness.resolveDockerEnvPolicyEpoch(cfg.docker.env),
      workspaceAccess: cfg.workspaceAccess,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
    });
    const oldHash = `${genericHash}:podman-runtime-v8:keep-id:default`;
    cfg.dockerTmpfsSource = "configured";
    spawnState.inspectRunning = false;
    spawnState.labelHash = oldHash;
    registryMocks.readRegistryEntry.mockResolvedValue({
      containerName: "oc-test-podman-shared",
      backendId: "podman",
      backendTarget: { key: "local", globalArgs: [] },
      sessionKey: "shared",
      createdAtMs: 1,
      lastUsedAtMs: 0,
      image: cfg.docker.image,
      configHash: oldHash,
    });

    await expect(
      harness.ensureSandboxContainer({
        engine: harness.PODMAN_SANDBOX_ENGINE,
        scopeKey: "agent:main:session-1",
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
      ensureSandboxCreateCallForTest({ cfg, engine: harness.PODMAN_SANDBOX_ENGINE }),
    ).rejects.toThrow("would cover Podman's init path");
  });

  it("allows Podman Machine workspaces under the default home share", async () => {
    const cfg = createSandboxConfig([]);
    const workspaceDir = path.join(os.homedir(), "openclaw-podman-workspace");
    cfg.docker.binds = [`${workspaceDir}:/workspace:rw`];
    usePodmanMachine();
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    const createCall = await ensureSandboxCreateCallForTest({
      cfg,
      workspaceDir,
      engine: harness.PODMAN_SANDBOX_ENGINE,
    });

    expect(createCall.command).toBe("podman");
    expect(createCall.globalArgs).toEqual([
      "--url",
      "ssh://core@127.0.0.1:60000/run/user/501/podman/podman.sock",
      "--identity",
      "/tmp/podman-machine-default",
    ]);
  });

  it("rejects Podman Machine bind sources outside the default home share", async () => {
    const cfg = createSandboxConfig([]);
    usePodmanMachine();
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    await expect(
      harness.ensureSandboxContainer({
        engine: harness.PODMAN_SANDBOX_ENGINE,
        scopeKey: "agent:test:session",
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/workspace",
        cfg,
      }),
    ).rejects.toThrow(/outside the default host home share/u);

    expect(spawnState.calls.some((call) => call.args[0] === "create")).toBe(false);
  });
});
