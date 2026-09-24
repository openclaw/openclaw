import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SANDBOX_DOCKER_CREATE_ARGS_EPOCH } from "./constants.js";
import { createSandboxContainerTestHarness } from "./docker.create.test-helpers.js";
import { collectDockerFlagValues } from "./test-args.js";
import { SANDBOX_MOUNT_FORMAT_VERSION } from "./workspace-mounts.js";

describe("ensureSandboxContainer managed mounts", () => {
  const harness = createSandboxContainerTestHarness();
  const {
    resolveDockerSourceNamespace,
    spawnState,
    registryMocks,
    tempDirs,
    createSandboxConfig,
    computeTestSandboxHash,
    ensureSandboxCreateCallForTest,
  } = harness;

  it.each(["none", "ro", "rw"] as const)(
    "creates Docker mounts in the daemon namespace for %s access",
    async (access) => {
      const root = fs.realpathSync(tempDirs.make("openclaw-dood-"));
      for (const dir of ["private/skills", "agent/skills", "materialized/skills"]) {
        fs.mkdirSync(path.join(root, dir), { recursive: true });
      }
      vi.mocked(resolveDockerSourceNamespace).mockResolvedValue([
        { type: "bind", source: "/host/state", destination: root, writable: true },
      ]);
      spawnState.containerExists = false;
      registryMocks.readRegistryEntry.mockResolvedValue(null);
      await harness.ensureSandboxContainer({
        scopeKey: "shared",
        workspaceDir: path.join(root, access === "rw" ? "agent" : "private"),
        agentWorkspaceDir: path.join(root, "agent"),
        skillsWorkspaceDir: path.join(root, "materialized"),
        cfg: createSandboxConfig([], [], access),
      });
      const binds = collectDockerFlagValues(
        spawnState.calls.find((call) => call.args[0] === "create")?.args ?? [],
        "-v",
      );
      expect(binds).toContain(
        `/host/state/${access === "rw" ? "agent" : "private"}:/workspace:${access === "ro" ? "ro,z" : "z"}`,
      );
      expect(binds.includes("/host/state/agent:/agent:ro,z")).toBe(access === "ro");
      if (access === "rw") {
        expect(binds).toContain(
          "/host/state/materialized/skills:/workspace/.openclaw/sandbox-skills/skills:ro,z",
        );
      }
      expect(binds.some((bind) => bind.startsWith(root))).toBe(false);
    },
  );

  it("preserves a hot container after a source change, then recreates it when stopped", async () => {
    const workspaceDir = fs.realpathSync(tempDirs.make("openclaw-dood-"));
    const cfg = createSandboxConfig([], []);
    const params = { scopeKey: "shared", workspaceDir, agentWorkspaceDir: workspaceDir, cfg };
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
    expect(spawnState.calls.some((call) => ["rm", "create", "start"].includes(call.args[0]!))).toBe(
      false,
    );
    expect(spawnState.labelHash).toBe(firstHash);
    spawnState.inspectRunning = false;
    await harness.ensureSandboxContainer(params);
    expect(spawnState.calls.some((call) => call.args[0] === "rm")).toBe(true);
    expect(spawnState.labelHash).not.toBe(firstHash);
    expect(
      collectDockerFlagValues(
        spawnState.calls.find((call) => call.args[0] === "create")?.args ?? [],
        "-v",
      ),
    ).toContain("/host/second:/workspace:z");
  });

  it("refuses a pre-fix hot container with a removed skill overlay", async () => {
    const workspaceDir = tempDirs.make("openclaw-dood-");
    spawnState.mounts = JSON.stringify([
      { Type: "bind", Source: workspaceDir, Destination: "/workspace", RW: true },
      {
        Type: "bind",
        Source: `${workspaceDir}/skills`,
        Destination: "/workspace/skills",
        RW: false,
      },
    ]);
    registryMocks.readRegistryEntry.mockResolvedValue(null);
    await expect(
      harness.ensureSandboxContainer({
        scopeKey: "shared",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        cfg: createSandboxConfig([], [], "none"),
      }),
    ).rejects.toThrow("Sandbox mounts changed");
    expect(spawnState.calls.some((call) => call.args[0] === "rm")).toBe(false);
  });

  it.each(["docker", "podman"] as const)(
    "preserves hot %s tmpfs removal and replaces it only after stopping",
    async (backend) => {
      const workspaceDir = tempDirs.make("openclaw-tmpfs-lifecycle-");
      const cfg = createSandboxConfig([], [], "rw");
      cfg.backend = backend;
      cfg.docker.tmpfs = ["/workspace/cache:rw"];
      const params = {
        scopeKey: "shared",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        cfg,
        ...(backend === "podman" ? { engine: harness.PODMAN_SANDBOX_ENGINE } : {}),
      };
      spawnState.containerExists = false;
      registryMocks.readRegistryEntry.mockResolvedValue(null);
      await harness.ensureSandboxContainer(params);
      const firstHash = spawnState.labelHash;
      spawnState.mounts = JSON.stringify([
        { Type: "bind", Source: workspaceDir, Destination: "/workspace", RW: true },
      ]);
      spawnState.tmpfs = { "/workspace/cache": backend === "podman" ? "rw,nosuid,nodev" : "rw" };
      cfg.docker.env = { CHANGED: "1" };
      await expect(harness.ensureSandboxContainer(params)).resolves.toBeDefined();
      cfg.docker.tmpfs = [];
      spawnState.calls.length = 0;
      await expect(harness.ensureSandboxContainer(params)).rejects.toThrow(
        "Sandbox mounts changed",
      );
      expect(
        spawnState.calls.some((call) => ["rm", "create", "start"].includes(call.args[0]!)),
      ).toBe(false);
      expect(spawnState.labelHash).toBe(firstHash);
      spawnState.inspectRunning = false;
      await harness.ensureSandboxContainer(params);
      const create = spawnState.calls.find((call) => call.args[0] === "create");
      expect(create).toBeDefined();
      expect(collectDockerFlagValues(create!.args, "--tmpfs")).not.toContain("/workspace/cache:rw");
      expect(spawnState.labelHash).not.toBe(firstHash);
    },
  );

  it("applies custom binds after workspace mounts so overlapping binds can override", async () => {
    const workspaceDir = tempDirs.make("openclaw-docker-mounts-");
    const customRoot = tempDirs.make("openclaw-docker-mounts-");
    const customUserFile = path.join(customRoot, "USER.md");
    const cfg = createSandboxConfig(["1.1.1.1"], [`${customUserFile}:/workspace/USER.md:ro`]);
    cfg.docker.dangerouslyAllowExternalBindSources = true;
    const expectedHash = await computeTestSandboxHash({
      docker: cfg.docker,
      workspaceAccess: cfg.workspaceAccess,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
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

  it.each(["docker", "podman"] as const)(
    "skips user binds that conflict with protected skill overlays for %s",
    async (backend) => {
      // The protected overlay remains authoritative for both engines, avoiding
      // duplicate mount rejection without making checked-in skills writable.
      const workspaceDir = tempDirs.make("openclaw-docker-mounts-");
      const customRoot = tempDirs.make("openclaw-docker-mounts-");
      fs.mkdirSync(path.join(workspaceDir, "skills", "demo"), { recursive: true });
      const customMount = `${customRoot}:/workspace/skills:rw`;
      const cfg = createSandboxConfig([], [customMount]);
      cfg.backend = backend;
      cfg.docker.workdir = "/workspace/.";
      cfg.docker.dangerouslyAllowExternalBindSources = true;
      spawnState.inspectRunning = false;
      registryMocks.readRegistryEntry.mockResolvedValue(null);

      const engine = backend === "podman" ? harness.PODMAN_SANDBOX_ENGINE : undefined;
      const createCall = await ensureSandboxCreateCallForTest({ cfg, workspaceDir, engine });
      const bindArgs = collectDockerFlagValues(createCall.args, "-v");

      expect(createCall.command).toBe(backend);
      expect(bindArgs).not.toContain(customMount);
      expect(bindArgs).toContain(`${path.join(workspaceDir, "skills")}:/workspace/skills:ro,z`);
    },
  );

  it.each([
    { workspaceAccess: "rw" as const, expectedMainMount: "/tmp/workspace:/workspace:z" },
    { workspaceAccess: "ro" as const, expectedMainMount: "/tmp/workspace:/workspace:ro,z" },
    { workspaceAccess: "none" as const, expectedMainMount: "/tmp/workspace:/workspace:z" },
  ])(
    "uses expected main mount permissions when workspaceAccess=$workspaceAccess",
    async ({ workspaceAccess, expectedMainMount }) => {
      const workspaceDir = "/tmp/workspace";
      const cfg = createSandboxConfig([], [], workspaceAccess);

      spawnState.inspectRunning = false;
      registryMocks.readRegistryEntry.mockResolvedValue(null);

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
    spawnState.mounts = "[]";
    vi.mocked(resolveDockerSourceNamespace).mockResolvedValue(undefined);
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    const createCall = await ensureSandboxCreateCallForTest({ cfg, workspaceDir });
    expect(createCall.args).toContain(
      `openclaw.mountFormatVersion=${SANDBOX_MOUNT_FORMAT_VERSION}`,
    );
  });
});
