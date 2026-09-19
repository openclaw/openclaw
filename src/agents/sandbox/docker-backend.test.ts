// Docker backend manager tests cover runtime image matching and removal error
// handling for sandbox and browser containers.
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveSandboxConfigForAgent } from "./config.js";

const dockerMocks = vi.hoisted(() => ({
  containerState: vi.fn(),
  ensureSandboxContainer: vi.fn(),
  execContainer: vi.fn(),
  execContainerRaw: vi.fn(),
  resolvePodmanSandboxRuntimeInfo: vi.fn(),
  validateSandboxContainerEngineTarget: vi.fn(),
}));

vi.mock("./docker.js", async () => {
  const actual = await vi.importActual<typeof import("./docker.js")>("./docker.js");
  return {
    ...actual,
    containerState: dockerMocks.containerState,
    ensureSandboxContainer: dockerMocks.ensureSandboxContainer,
    execContainer: dockerMocks.execContainer,
    execContainerRaw: dockerMocks.execContainerRaw,
    resolvePodmanSandboxRuntimeInfo: dockerMocks.resolvePodmanSandboxRuntimeInfo,
    validateSandboxContainerEngineTarget: dockerMocks.validateSandboxContainerEngineTarget,
  };
});

vi.mock("./container-engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./container-engine.js")>()),
  execContainer: dockerMocks.execContainer,
}));

const {
  createDockerSandboxBackend,
  createPodmanSandboxBackend,
  dockerSandboxBackendManager,
  podmanSandboxBackendManager,
} = await import("./docker-backend.js");

function createConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          scope: "session",
          workspaceAccess: "none",
          docker: {
            image: "openclaw-sandbox:bookworm-slim",
          },
          browser: {
            enabled: true,
            image: "openclaw-sandbox-browser:bookworm-slim",
          },
        },
      },
      list: [],
    },
  };
}

async function createDockerExecBackend() {
  dockerMocks.ensureSandboxContainer.mockResolvedValueOnce("sandbox-container");
  return createDockerSandboxBackend({
    sessionKey: "agent:coder:main",
    scopeKey: "agent:coder:main",
    workspaceDir: "/workspace",
    agentWorkspaceDir: "/workspace",
    cfg: resolveSandboxConfigForAgent(createConfig()),
  });
}

describe("docker sandbox backend manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dockerMocks.containerState.mockResolvedValue({
      exists: true,
      running: true,
    });
    dockerMocks.execContainer.mockImplementation(async (_engine, args: string[]) => ({
      code: 0,
      stdout: args.includes('{"Mounts":{{json .Mounts}},"Tmpfs":{{json .HostConfig.Tmpfs}}}')
        ? JSON.stringify({ Mounts: [], Tmpfs: null })
        : args.includes("{{.Id}}")
          ? "a".repeat(64)
          : args.includes("/proc/self/mountinfo")
            ? "1 1 0:1 / / rw - overlay overlay rw\n2 1 8:1 /workspace /workspace rw - ext4 /dev/root rw\n"
            : "unused-image",
      stderr: "",
    }));
    dockerMocks.resolvePodmanSandboxRuntimeInfo.mockResolvedValue({
      machine: false,
      rootless: true,
      target: { key: "local", globalArgs: [] },
    });
  });

  it("rechecks runtime authority after awaited engine validation before filesystem exec", async () => {
    let current = true;
    dockerMocks.ensureSandboxContainer.mockResolvedValueOnce("sandbox-container");
    const backend = await createDockerSandboxBackend({
      sessionKey: "agent:coder:main",
      scopeKey: "agent:coder:main",
      workspaceDir: "/workspace",
      agentWorkspaceDir: "/workspace",
      cfg: resolveSandboxConfigForAgent(createConfig()),
      assertRuntimeCurrent: () => {
        if (!current) {
          throw new Error("runtime revoked");
        }
      },
    });
    dockerMocks.validateSandboxContainerEngineTarget.mockImplementationOnce(async () => {
      await Promise.resolve();
      current = false;
    });
    await expect(backend.runShellCommand({ script: "write should not run" })).rejects.toThrow(
      "runtime revoked",
    );
    expect(dockerMocks.execContainerRaw).not.toHaveBeenCalled();
  });

  it.each(["identity", "mounts"] as const)(
    "does not execute a mount probe after authority retires during %s inspection",
    async (stage) => {
      let current = true;
      const execute = dockerMocks.execContainer.getMockImplementation()!;
      dockerMocks.execContainer.mockImplementation(async (engine, args, options) => {
        const result = await execute(engine, args, options);
        if (
          args[0] === "inspect" &&
          (stage === "identity"
            ? args.includes("{{.Id}}")
            : args.some((arg: string) => arg.includes("Mounts")))
        ) {
          current = false;
        }
        return result;
      });
      dockerMocks.ensureSandboxContainer.mockResolvedValueOnce("sandbox-container");
      await expect(
        createDockerSandboxBackend({
          sessionKey: "agent:coder:main",
          scopeKey: "agent:coder:main",
          workspaceDir: "/workspace",
          agentWorkspaceDir: "/workspace",
          cfg: resolveSandboxConfigForAgent(createConfig()),
          assertRuntimeCurrent: () => {
            if (!current) {
              throw new Error("runtime retired");
            }
          },
        }),
      ).rejects.toThrow("runtime retired");
      expect(dockerMocks.execContainer.mock.calls.some(([, args]) => args[0] === "exec")).toBe(
        false,
      );
    },
  );

  it("pins retained termination to its original container generation", async () => {
    const backend = await createDockerExecBackend();
    const cleanup = backend.prepareProcessCleanup!({});
    dockerMocks.execContainerRaw.mockResolvedValueOnce({
      code: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
    // The stable display name may now refer to a different container.
    await cleanup.terminate();
    expect(dockerMocks.execContainerRaw.mock.calls.at(-1)?.[1]?.[2]).toBe("a".repeat(64));
  });

  it.each(["removed", "unreachable", "still present"] as const)(
    "settles retained cleanup only for confirmed generation removal: %s",
    async (state) => {
      const backend = await createDockerExecBackend();
      const cleanup = backend.prepareProcessCleanup!({});
      dockerMocks.execContainerRaw.mockResolvedValueOnce({
        code: 125,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("exec failed"),
      });
      dockerMocks.execContainer.mockResolvedValueOnce({
        code: state === "still present" ? 0 : 1,
        stdout: state === "still present" ? "a".repeat(64) : "",
        stderr:
          state === "removed" ? `Error: No such object: ${"a".repeat(64)}` : "engine unreachable",
      });
      if (state === "removed") {
        await expect(cleanup.terminate()).resolves.toBeUndefined();
      } else {
        await expect(cleanup.terminate()).rejects.toThrow("exec failed");
      }
      expect(dockerMocks.execContainer.mock.calls.at(-1)?.[1]).toEqual([
        "inspect",
        "--format",
        "{{.Id}}",
        "a".repeat(64),
      ]);
    },
  );

  it("pins ordinary filesystem dispatch to the same prepared generation", async () => {
    const backend = await createDockerExecBackend();
    dockerMocks.execContainerRaw.mockResolvedValueOnce({
      code: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
    await backend.runShellCommand({ script: "true" });
    expect(dockerMocks.execContainerRaw.mock.calls.at(-1)?.[1]?.[2]).toBe("a".repeat(64));
  });

  it("forwards the canonical scope key to container provisioning", async () => {
    dockerMocks.ensureSandboxContainer.mockResolvedValueOnce("sandbox-container");
    const scopeKey = `agent:poly:workspace:${"a".repeat(32)}`;
    const readOnlyResourceMounts = [
      { hostPath: "/host/attachments", containerPath: "/openclaw/attachments" },
    ];

    await createDockerSandboxBackend({
      sessionKey: "agent:poly:msteams:channel-1",
      scopeKey,
      workspaceDir: "/tmp/customer/workspace",
      agentWorkspaceDir: "/tmp/customer/workspace",
      readOnlyResourceMounts,
      cfg: resolveSandboxConfigForAgent(createConfig(), "poly"),
    });

    expect(dockerMocks.ensureSandboxContainer).toHaveBeenCalledWith(
      expect.objectContaining({ scopeKey, readOnlyResourceMounts }),
    );
  });

  it("captures image-volume masks once for the filesystem bridge after provisioning", async () => {
    dockerMocks.execContainer
      .mockResolvedValueOnce({ code: 0, stdout: "a".repeat(64), stderr: "" })
      .mockResolvedValueOnce({
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          Mounts: [
            { Type: "bind", Source: "/host/project", Destination: "/workspace", RW: true },
            { Type: "volume", Source: "/engine/volume", Destination: "/workspace/cache", RW: true },
            {
              Type: "bind",
              Source: "/host/export",
              Destination: "/workspace/cache/export",
              RW: false,
            },
          ],
          Tmpfs: { "/tmp": "rw" },
        }),
      })
      .mockResolvedValueOnce({
        code: 0,
        stderr: "",
        stdout: [
          "1 1 0:1 / / rw - overlay overlay rw",
          "2 1 8:1 /project /workspace rw - ext4 /dev/root rw",
          "3 2 8:1 /volume /workspace/cache rw - ext4 /dev/root rw",
          "4 3 8:1 /export /workspace/cache/export ro - ext4 /dev/root rw",
        ].join("\n"),
      });
    const backend = await createDockerExecBackend();
    const bridge = backend.createFsBridge!({
      sandbox: {
        workspaceDir: "/host/project",
        agentWorkspaceDir: "/host/project",
        workspaceAccess: "rw",
        containerName: backend.runtimeId,
        containerWorkdir: "/workspace",
        docker: { binds: ["/host/export:/workspace/cache/export:ro"] },
        backend,
      },
    });
    expect(() => bridge.resolvePath({ filePath: "cache/marker" })).toThrow("container-only");
    expect(() => bridge.resolvePath({ filePath: "/workspace/cache/marker" })).toThrow(
      "container-only",
    );
    expect(bridge.resolvePath({ filePath: "cache/export/marker" }).hostPath).toBe(
      path.resolve("/host/export/marker"),
    );
    expect(dockerMocks.execContainer).toHaveBeenCalledTimes(3);
    expect(dockerMocks.ensureSandboxContainer.mock.invocationCallOrder[0]).toBeLessThan(
      dockerMocks.execContainer.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    {
      name: "tmpfs destination alias and retained retarget",
      binds: [],
      tmpfs: { "/workspace/link": "rw" },
      table: ["3 2 0:9 / /workspace/cache rw - tmpfs tmpfs rw"],
      masked: ["/workspace/link/marker", "/workspace/cache/marker"],
      readable: ["/workspace/other/marker"],
    },
    {
      name: "different backing stacked on a declared bind",
      binds: [
        { source: "/host/cache", target: "/workspace/cache", writable: true },
        { source: "/host/hidden", target: "/workspace/cache/hidden", writable: true },
        { source: "/host/live", target: "/workspace/cache/live", writable: true },
      ],
      tmpfs: { "/workspace/aliases/link": "rw" },
      table: [
        "3 2 8:1 /cache /workspace/cache rw - ext4 /dev/root rw",
        "4 3 8:1 /hidden /workspace/cache/hidden rw - ext4 /dev/root rw",
        "5 3 0:9 / /workspace/cache rw - tmpfs tmpfs rw",
        "6 5 8:1 /live /workspace/cache/live rw - ext4 /dev/root rw",
      ],
      masked: ["/workspace/cache/marker", "/workspace/cache/hidden/marker"],
      readable: ["/workspace/cache/live/marker"],
    },
    {
      name: "intervening tmpfs hides an older sibling bind",
      binds: [{ source: "/host/export", target: "/workspace/cache/export", writable: true }],
      tmpfs: { "/workspace/aliases/deep/link": "rw" },
      table: [
        "3 2 8:1 /export /workspace/cache/export rw - ext4 /dev/root rw",
        "4 2 0:9 / /workspace/cache rw - tmpfs tmpfs rw",
      ],
      masked: ["/workspace/cache/marker", "/workspace/cache/export/marker"],
      readable: ["/workspace/other/marker"],
    },
    {
      name: "bind attached inside the intervening tmpfs remains visible",
      binds: [{ source: "/host/export", target: "/workspace/cache/export", writable: true }],
      tmpfs: { "/workspace/aliases/deep/link": "rw" },
      table: [
        "3 2 0:9 / /workspace/cache rw - tmpfs tmpfs rw",
        "4 3 8:1 /export /workspace/cache/export rw - ext4 /dev/root rw",
      ],
      masked: ["/workspace/cache/marker"],
      readable: ["/workspace/cache/export/marker"],
    },
    {
      name: "identical recursive bind backing with a readonly top",
      binds: [{ source: "/host/export", target: "/workspace/export", writable: false }],
      tmpfs: {},
      table: [
        "3 2 8:1 /export /workspace/export rw - ext4 /dev/root rw",
        "4 3 8:1 /export /workspace/export ro - ext4 /dev/root rw",
      ],
      masked: [],
      readable: ["/workspace/export/marker"],
    },
    {
      name: "readonly bind with mismatched realized access",
      binds: [{ source: "/host/export", target: "/workspace/export", writable: false }],
      tmpfs: {},
      table: ["3 2 8:1 /export /workspace/export rw - ext4 /dev/root rw"],
      masked: ["/workspace/export/marker"],
      readable: [],
    },
    {
      name: "escaped whitespace in realized bind paths",
      binds: [{ source: "/host/export ", target: "/workspace/export ", writable: false }],
      tmpfs: {},
      table: ["3 2 8:1 /export\\040 /workspace/export\\040 ro - ext4 /dev/root rw"],
      masked: [],
      readable: ["/workspace/export /marker"],
    },
    {
      name: "visible recursive child above a hidden older child",
      binds: [{ source: "/host/export", target: "/workspace/export", writable: false }],
      tmpfs: {},
      table: [
        "3 2 8:1 /export /workspace/export rw - ext4 /dev/root rw",
        "4 2 8:1 /project /workspace rw - ext4 /dev/root rw",
        "5 4 8:1 /export /workspace/export rw - ext4 /dev/root rw",
        "6 5 8:1 /export /workspace/export ro - ext4 /dev/root rw",
      ],
      masked: [],
      readable: ["/workspace/export/marker"],
    },
    {
      name: "different backing above a hidden older bind",
      binds: [{ source: "/host/cache", target: "/workspace/cache", writable: true }],
      tmpfs: { "/workspace/aliases/link": "rw" },
      table: [
        "3 2 8:1 /cache /workspace/cache rw - ext4 /dev/root rw",
        "4 2 8:1 /project /workspace rw - ext4 /dev/root rw",
        "5 4 0:9 / /workspace/cache rw - tmpfs tmpfs rw",
      ],
      masked: ["/workspace/cache/marker"],
      readable: ["/workspace/other/marker"],
    },
    {
      name: "bind destination alias without a realized lexical mount",
      binds: [{ source: "/host/export", target: "/workspace/link", writable: true }],
      tmpfs: {},
      table: ["3 2 8:1 /export /workspace/cache rw - ext4 /dev/root rw"],
      masked: ["/workspace/link/marker", "/workspace/cache/marker"],
      readable: ["/workspace/other/marker"],
    },
  ])("captures realized masks for $name", async ({ binds, tmpfs, table, masked, readable }) => {
    dockerMocks.execContainer
      .mockResolvedValueOnce({ code: 0, stdout: "a".repeat(64), stderr: "" })
      .mockResolvedValueOnce({
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          Mounts: [
            { Type: "bind", Source: "/host/project", Destination: "/workspace", RW: true },
            ...binds.map((bind) => ({
              Type: "bind",
              Source: bind.source,
              Destination: bind.target,
              RW: bind.writable,
            })),
          ],
          Tmpfs: tmpfs,
        }),
      })
      .mockResolvedValueOnce({
        code: 0,
        stderr: "",
        stdout: [
          "1 1 0:1 / / rw - overlay overlay rw",
          "2 1 8:1 /project /workspace rw - ext4 /dev/root rw",
          ...table,
        ].join("\n"),
      });
    const backend = await createDockerExecBackend();
    const bridge = backend.createFsBridge!({
      sandbox: {
        workspaceDir: "/host/project",
        agentWorkspaceDir: "/host/project",
        workspaceAccess: "rw",
        containerName: backend.runtimeId,
        containerWorkdir: "/workspace",
        docker: {
          binds: binds.map(
            (bind) => `${bind.source}:${bind.target}:${bind.writable ? "rw" : "ro"}`,
          ),
        },
        backend,
      },
    });
    for (const filePath of masked) {
      expect(() => bridge.resolvePath({ filePath })).toThrow("container-only");
    }
    for (const filePath of readable) {
      expect(bridge.resolvePath({ filePath }).containerPath).toBe(filePath);
    }
    expect(dockerMocks.execContainer).toHaveBeenCalledTimes(3);
  });

  it("does not return a backend when its filesystem snapshot cannot be read", async () => {
    dockerMocks.execContainer.mockRejectedValueOnce(new Error("inspect failed"));
    await expect(createDockerExecBackend()).rejects.toThrow("inspect failed");
  });

  it("binds Podman provisioning and later execs to the resolved target", async () => {
    dockerMocks.ensureSandboxContainer.mockResolvedValueOnce("sandbox-podman");
    const podmanTarget = {
      key: `machine:${"a".repeat(32)}`,
      globalArgs: [
        "--url",
        "ssh://core@127.0.0.1:60001/run/user/501/podman/podman.sock",
        "--identity",
        "/tmp/podman-machine-key",
      ],
    };
    dockerMocks.resolvePodmanSandboxRuntimeInfo.mockResolvedValueOnce({
      machine: true,
      rootless: true,
      target: podmanTarget,
    });
    const config = createConfig();
    config.agents!.defaults!.sandbox!.backend = "podman";
    config.agents!.defaults!.sandbox!.browser!.enabled = false;

    const backend = await createPodmanSandboxBackend({
      sessionKey: "agent:coder:main",
      scopeKey: "agent:coder:main",
      workspaceDir: "/workspace",
      agentWorkspaceDir: "/workspace",
      cfg: resolveSandboxConfigForAgent(config),
    });
    const execSpec = await backend.buildExecSpec({
      command: "true",
      env: {},
      usePty: false,
    });

    expect(dockerMocks.ensureSandboxContainer).toHaveBeenCalledWith(
      expect.objectContaining({ podmanTarget }),
    );
    expect(dockerMocks.execContainer).toHaveBeenCalledWith(
      expect.objectContaining({ id: "podman", globalArgs: podmanTarget.globalArgs }),
      expect.arrayContaining(["inspect", "sandbox-podman"]),
      expect.anything(),
    );
    expect(dockerMocks.validateSandboxContainerEngineTarget).toHaveBeenCalledWith(
      expect.objectContaining({ id: "podman" }),
      podmanTarget,
    );
    expect(execSpec.argv.slice(0, 6)).toEqual(["podman", ...podmanTarget.globalArgs, "exec"]);
    expect(execSpec.stdinMode).toBe("pipe-closed");
    await backend.finalizeExec?.({
      status: "completed",
      exitCode: 0,
      timedOut: false,
      token: execSpec.finalizeToken,
    });
  });

  it("delivers exec environment outside process arguments and cleans it after finalization", async () => {
    const sentinel = "synthetic-container-exec-transport-value";
    const requestedPath = "/synthetic/bin:/synthetic/system/bin";
    const backend = await createDockerExecBackend();

    const execSpec = await backend.buildExecSpec({
      command: "printf ready",
      workdir: "/workspace/project",
      env: { CONFIGURED_VALUE: sentinel, PATH: requestedPath },
      usePty: true,
    });

    expect(execSpec.argv.join(" ")).not.toContain(sentinel);
    expect(execSpec.argv.join(" ")).not.toContain(requestedPath);
    expect(execSpec.argv).not.toContain("-e");
    expect(execSpec.argv).toContain("-t");
    expect(execSpec.argv).toContain("-w");
    expect(execSpec.argv).toContain("/workspace/project");
    expect(execSpec.argv.slice(-4, -1)).toEqual(["a".repeat(64), "/bin/sh", "-lc"]);
    expect(execSpec.argv.at(-1)).toBe(
      'export PATH="${OPENCLAW_PREPEND_PATH}:$PATH"; unset OPENCLAW_PREPEND_PATH; printf ready',
    );
    expect(execSpec.stdinMode).toBe("pipe-open");
    const envFile = execSpec.argv[execSpec.argv.indexOf("--env-file") + 1];
    expect(envFile).toBeDefined();
    const envFileContent = fs.readFileSync(envFile!, "utf8");
    expect(envFileContent).toContain(`CONFIGURED_VALUE=${sentinel}\n`);
    expect(envFileContent).toContain(`OPENCLAW_PREPEND_PATH=${requestedPath}\n`);
    expect(envFileContent).not.toMatch(/^PATH=/m);
    expect(backend.finalizeExec).toBeDefined();

    const finalization = {
      status: "completed",
      exitCode: 0,
      timedOut: false,
      token: execSpec.finalizeToken,
    } as const;
    await backend.finalizeExec?.(finalization);

    expect(fs.existsSync(envFile!)).toBe(false);
    await expect(backend.finalizeExec?.(finalization)).resolves.toBeUndefined();
  });

  it.each([
    {
      description: "never interpolates shell metacharacters from PATH into the command",
      requestedPath: "$(touch /tmp/openclaw-path-injection)",
      expectedCommand:
        'export PATH="${OPENCLAW_PREPEND_PATH}:$PATH"; unset OPENCLAW_PREPEND_PATH; echo hello',
    },
    {
      description: "does not add a PATH export when PATH is absent",
      requestedPath: undefined,
      expectedCommand: "echo hello",
    },
  ])("$description", async ({ requestedPath, expectedCommand }) => {
    const backend = await createDockerExecBackend();
    const execSpec = await backend.buildExecSpec({
      command: "echo hello",
      env: { HOME: "/synthetic/home", ...(requestedPath ? { PATH: requestedPath } : {}) },
      usePty: false,
    });

    try {
      expect(execSpec.argv.at(-1)).toBe(expectedCommand);
      const envFile = execSpec.argv[execSpec.argv.indexOf("--env-file") + 1];
      const envFileContent = fs.readFileSync(envFile!, "utf8");
      if (requestedPath) {
        expect(execSpec.argv.join(" ")).not.toContain(requestedPath);
        expect(envFileContent).toContain(`OPENCLAW_PREPEND_PATH=${requestedPath}\n`);
      } else {
        expect(envFileContent).not.toContain("OPENCLAW_PREPEND_PATH=");
      }
    } finally {
      await backend.finalizeExec?.({
        status: "completed",
        exitCode: 0,
        timedOut: false,
        token: execSpec.finalizeToken,
      });
    }
  });

  it("matches ordinary sandbox runtimes against sandbox.docker.image", async () => {
    dockerMocks.execContainer.mockResolvedValueOnce({
      code: 0,
      stdout: "openclaw-sandbox:bookworm-slim\n",
      stderr: "",
    });

    const result = await dockerSandboxBackendManager.describeRuntime({
      entry: {
        containerName: "sandbox-1",
        backendId: "docker",
        runtimeLabel: "sandbox-1",
        sessionKey: "agent:coder:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "stale-entry-image",
        configLabelKind: "Image",
      },
      config: createConfig(),
      agentId: "coder",
    });

    expect(result).toEqual({
      running: true,
      actualConfigLabel: "openclaw-sandbox:bookworm-slim",
      configLabelMatch: true,
    });
  });

  it("matches browser runtimes against sandbox.browser.image", async () => {
    dockerMocks.execContainer.mockResolvedValueOnce({
      code: 0,
      stdout: "openclaw-sandbox-browser:bookworm-slim\n",
      stderr: "",
    });

    const result = await dockerSandboxBackendManager.describeRuntime({
      entry: {
        containerName: "browser-1",
        backendId: "docker",
        runtimeLabel: "browser-1",
        sessionKey: "agent:coder:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "stale-entry-image",
        configLabelKind: "BrowserImage",
      },
      config: createConfig(),
      agentId: "coder",
    });

    expect(result).toEqual({
      running: true,
      actualConfigLabel: "openclaw-sandbox-browser:bookworm-slim",
      configLabelMatch: true,
    });
  });

  it("defaults docker-backed runtime matching to sandbox.docker.image when label kind is missing", async () => {
    // Older registry entries did not record configLabelKind; keep ordinary
    // sandbox matching stable for those existing containers.
    dockerMocks.execContainer.mockResolvedValueOnce({
      code: 0,
      stdout: "openclaw-sandbox:bookworm-slim\n",
      stderr: "",
    });

    const result = await dockerSandboxBackendManager.describeRuntime({
      entry: {
        containerName: "sandbox-legacy",
        backendId: "docker",
        runtimeLabel: "sandbox-legacy",
        sessionKey: "agent:coder:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "stale-entry-image",
      },
      config: createConfig(),
      agentId: "coder",
    });

    expect(result).toEqual({
      running: true,
      actualConfigLabel: "openclaw-sandbox:bookworm-slim",
      configLabelMatch: true,
    });
  });

  it("reports Docker runtime removal failures", async () => {
    dockerMocks.execContainer.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "permission denied",
    });

    await expect(
      dockerSandboxBackendManager.removeRuntime({
        entry: {
          containerName: "sandbox-1",
          backendId: "docker",
          runtimeLabel: "sandbox-1",
          sessionKey: "agent:coder:main",
          createdAtMs: 1,
          lastUsedAtMs: 1,
          image: "openclaw-sandbox:bookworm-slim",
        },
        config: createConfig(),
      }),
    ).rejects.toThrow("Failed to remove Docker sandbox runtime sandbox-1: permission denied");
  });

  it("treats already-missing Docker runtimes as removed", async () => {
    // Prune/remove flows are idempotent; Docker may have already removed the
    // container by the time the manager runs.
    dockerMocks.execContainer.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "Error response from daemon: No such container: sandbox-1",
    });

    await expect(
      dockerSandboxBackendManager.removeRuntime({
        entry: {
          containerName: "sandbox-1",
          backendId: "docker",
          runtimeLabel: "sandbox-1",
          sessionKey: "agent:coder:main",
          createdAtMs: 1,
          lastUsedAtMs: 1,
          image: "openclaw-sandbox:bookworm-slim",
        },
        config: createConfig(),
      }),
    ).resolves.toBeUndefined();
  });

  it("uses Podman for Podman registry entries", async () => {
    dockerMocks.execContainer.mockResolvedValueOnce({
      code: 0,
      stdout: "",
      stderr: "",
    });

    await podmanSandboxBackendManager.removeRuntime({
      entry: {
        containerName: "sandbox-podman",
        backendId: "podman",
        backendTarget: { key: "local", globalArgs: [] },
        runtimeLabel: "sandbox-podman",
        sessionKey: "agent:coder:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "openclaw-sandbox:bookworm-slim",
      },
      config: createConfig(),
    });

    expect(dockerMocks.execContainer).toHaveBeenCalledWith(
      expect.objectContaining({ id: "podman", command: "podman" }),
      ["rm", "-f", "sandbox-podman"],
      { allowFailure: true },
    );
    expect(dockerMocks.validateSandboxContainerEngineTarget).toHaveBeenCalledWith(
      expect.objectContaining({ id: "podman", command: "podman" }),
      { key: "local", globalArgs: [] },
    );
  });

  it("rejects a stale Podman registry target before inspecting the runtime", async () => {
    const targetError = new Error("active Podman connection changed");
    dockerMocks.validateSandboxContainerEngineTarget.mockRejectedValueOnce(targetError);

    await expect(
      podmanSandboxBackendManager.describeRuntime({
        entry: {
          containerName: "sandbox-podman",
          backendId: "podman",
          backendTarget: {
            key: `machine:${"a".repeat(32)}`,
            globalArgs: ["--url", "ssh://core@127.0.0.1:60001/run/podman/podman.sock"],
          },
          runtimeLabel: "sandbox-podman",
          sessionKey: "agent:coder:main",
          createdAtMs: 1,
          lastUsedAtMs: 1,
          image: "openclaw-sandbox:bookworm-slim",
        },
        config: createConfig(),
      }),
    ).rejects.toBe(targetError);

    expect(dockerMocks.containerState).not.toHaveBeenCalled();
    expect(dockerMocks.execContainer).not.toHaveBeenCalled();
  });

  it("rejects a stale Podman registry target before removing the runtime", async () => {
    const targetError = new Error("active Podman connection changed");
    dockerMocks.validateSandboxContainerEngineTarget.mockRejectedValueOnce(targetError);

    await expect(
      podmanSandboxBackendManager.removeRuntime({
        entry: {
          containerName: "sandbox-podman",
          backendId: "podman",
          backendTarget: {
            key: `machine:${"a".repeat(32)}`,
            globalArgs: ["--url", "ssh://core@127.0.0.1:60001/run/podman/podman.sock"],
          },
          runtimeLabel: "sandbox-podman",
          sessionKey: "agent:coder:main",
          createdAtMs: 1,
          lastUsedAtMs: 1,
          image: "openclaw-sandbox:bookworm-slim",
        },
        config: createConfig(),
      }),
    ).rejects.toBe(targetError);

    expect(dockerMocks.execContainer).not.toHaveBeenCalled();
  });

  it("rejects browser sandboxing on the explicit Podman backend", async () => {
    const config = createConfig();
    config.agents!.defaults!.sandbox!.backend = "podman";
    await expect(
      createPodmanSandboxBackend({
        sessionKey: "agent:coder:main",
        scopeKey: "agent:coder:main",
        workspaceDir: "/workspace",
        agentWorkspaceDir: "/workspace",
        skillsWorkspaceDir: "/workspace/.openclaw/sandbox-skills",
        cfg: resolveSandboxConfigForAgent(config),
      }),
    ).rejects.toThrow(
      "Podman sandboxing does not support browser sandboxes. Install Docker and select the docker backend, or disable sandbox.browser.enabled.",
    );

    expect(dockerMocks.ensureSandboxContainer).not.toHaveBeenCalled();
  });

  it("matches canonical Podman image identity when Podman expands a short name", async () => {
    dockerMocks.execContainer
      .mockResolvedValueOnce({
        code: 0,
        stdout: "localhost/openclaw-sandbox:bookworm-slim\tsha256:abc123\n",
        stderr: "",
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: "abc123\n",
        stderr: "",
      });

    const result = await podmanSandboxBackendManager.describeRuntime({
      entry: {
        containerName: "sandbox-podman",
        backendId: "podman",
        backendTarget: { key: "local", globalArgs: [] },
        runtimeLabel: "sandbox-podman",
        sessionKey: "agent:coder:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "openclaw-sandbox:bookworm-slim",
        configLabelKind: "Image",
      },
      config: createConfig(),
      agentId: "coder",
    });

    expect(result).toEqual({
      running: true,
      actualConfigLabel: "localhost/openclaw-sandbox:bookworm-slim",
      configLabelMatch: true,
    });
    expect(dockerMocks.execContainer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: "podman", command: "podman" }),
      ["image", "inspect", "-f", "{{.Id}}", "openclaw-sandbox:bookworm-slim"],
      { allowFailure: true },
    );
  });
});
