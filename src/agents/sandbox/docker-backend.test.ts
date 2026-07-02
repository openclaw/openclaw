// Docker backend manager tests cover runtime image matching and removal error
// handling for sandbox and browser containers.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SandboxConfig } from "./types.js";

const dockerMocks = vi.hoisted(() => ({
  dockerContainerState: vi.fn(),
  ensureSandboxContainer: vi.fn(),
  execDocker: vi.fn(),
  execDockerRaw: vi.fn(),
}));

vi.mock("./docker.js", async () => {
  const actual = await vi.importActual<typeof import("./docker.js")>("./docker.js");
  return {
    ...actual,
    dockerContainerState: dockerMocks.dockerContainerState,
    ensureSandboxContainer: dockerMocks.ensureSandboxContainer,
    execDocker: dockerMocks.execDocker,
    execDockerRaw: dockerMocks.execDockerRaw,
  };
});

const { createDockerSandboxBackend, dockerSandboxBackendManager } =
  await import("./docker-backend.js");

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

function createSandboxConfig(): SandboxConfig {
  return {
    mode: "all",
    backend: "docker",
    scope: "agent",
    workspaceAccess: "rw",
    workspaceRoot: "~/.openclaw/sandboxes",
    docker: {
      image: "openclaw-sandbox:bookworm-slim",
      containerPrefix: "oc-test-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: ["/tmp", "/var/tmp", "/run"],
      network: "none",
      capDrop: ["ALL"],
      env: {},
      dns: [],
      extraHosts: [],
      binds: ["/tmp/customer/workspace:/workspace:rw"],
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
      image: "openclaw-sandbox-browser:bookworm-slim",
      containerPrefix: "oc-browser-",
      network: "openclaw-sandbox-browser",
      cdpPort: 9222,
      vncPort: 5900,
      noVncPort: 6080,
      headless: true,
      enableNoVnc: false,
      autoStart: false,
      autoStartTimeoutMs: 5_000,
      allowHostControl: false,
    },
    tools: {},
    prune: {
      idleHours: 0,
      maxAgeDays: 0,
    },
  };
}

describe("docker sandbox backend manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dockerMocks.dockerContainerState.mockResolvedValue({
      exists: true,
      running: true,
    });
    dockerMocks.execDocker.mockResolvedValue({
      code: 0,
      stdout: "unused-image",
      stderr: "",
    });
  });

  it("matches ordinary sandbox runtimes against sandbox.docker.image", async () => {
    dockerMocks.execDocker.mockResolvedValueOnce({
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

  it("forwards the resolved scope key to Docker container creation", async () => {
    dockerMocks.ensureSandboxContainer.mockResolvedValueOnce("sandbox-container");

    await createDockerSandboxBackend({
      sessionKey: "agent:poly:msteams:channel-1",
      scopeKey: "agent:poly:workspace:tenant123",
      workspaceDir: "/tmp/customer/workspace",
      agentWorkspaceDir: "/tmp/customer/workspace",
      cfg: createSandboxConfig(),
    });

    expect(dockerMocks.ensureSandboxContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:poly:msteams:channel-1",
        scopeKey: "agent:poly:workspace:tenant123",
      }),
    );
  });

  it("matches browser runtimes against sandbox.browser.image", async () => {
    dockerMocks.execDocker.mockResolvedValueOnce({
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
    dockerMocks.execDocker.mockResolvedValueOnce({
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
    dockerMocks.execDocker.mockResolvedValueOnce({
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
    dockerMocks.execDocker.mockResolvedValueOnce({
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
});
