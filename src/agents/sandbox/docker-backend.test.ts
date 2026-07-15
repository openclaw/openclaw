// Docker backend manager tests cover runtime image matching and removal error
// handling for sandbox and browser containers.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveSandboxConfigForAgent } from "./config.js";

const dockerMocks = vi.hoisted(() => ({
  containerState: vi.fn(),
  ensureSandboxContainer: vi.fn(),
  execContainer: vi.fn(),
  execContainerRaw: vi.fn(),
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
    validateSandboxContainerEngineTarget: dockerMocks.validateSandboxContainerEngineTarget,
  };
});

const { createPodmanSandboxBackend, dockerSandboxBackendManager, podmanSandboxBackendManager } =
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

describe("docker sandbox backend manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dockerMocks.containerState.mockResolvedValue({
      exists: true,
      running: true,
    });
    dockerMocks.execContainer.mockResolvedValue({
      code: 0,
      stdout: "unused-image",
      stderr: "",
    });
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
    );
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
