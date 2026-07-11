// Docker backend manager tests cover runtime image matching and removal error
// handling for sandbox and browser containers.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createDeferred } from "../../shared/deferred.js";
import { withSandboxIdleMutation } from "./activity.js";
import { resolveSandboxConfigForAgent } from "./config.js";

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

  it("holds sandbox activity until exec finalization", async () => {
    dockerMocks.ensureSandboxContainer.mockResolvedValue("sandbox-active");
    const cfg = resolveSandboxConfigForAgent(createConfig(), "coder");
    const backend = await createDockerSandboxBackend({
      sessionKey: "agent:coder:main",
      scopeKey: "agent:coder:main",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg,
    });
    const spec = await backend.buildExecSpec({ command: "sleep 60", env: {}, usePty: false });
    const mutated = vi.fn();
    const mutation = withSandboxIdleMutation("sandbox-active", async () => {
      mutated();
    });

    await Promise.resolve();
    expect(mutated).not.toHaveBeenCalled();
    await backend.finalizeExec?.({
      status: "completed",
      exitCode: 0,
      timedOut: false,
      token: spec.finalizeToken,
    });
    await mutation;
    expect(mutated).toHaveBeenCalledOnce();
  });

  it("aborts exec activity while a sandbox mutation is pending", async () => {
    dockerMocks.ensureSandboxContainer.mockResolvedValue("sandbox-abortable");
    const cfg = resolveSandboxConfigForAgent(createConfig(), "coder");
    const backend = await createDockerSandboxBackend({
      sessionKey: "agent:coder:main",
      scopeKey: "agent:coder:main",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg,
    });
    const mutationStarted = createDeferred();
    const finishMutation = createDeferred();
    const mutation = withSandboxIdleMutation("sandbox-abortable", async () => {
      mutationStarted.resolve();
      await finishMutation.promise;
    });
    await mutationStarted.promise;

    try {
      const controller = new AbortController();
      const queuedExec = backend.buildExecSpec({
        command: "echo queued",
        env: {},
        usePty: false,
        signal: controller.signal,
      });
      controller.abort();

      await expect(queuedExec).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      finishMutation.resolve();
      await mutation;
    }

    const next = await backend.buildExecSpec({
      command: "echo next",
      env: {},
      usePty: false,
    });
    await backend.finalizeExec?.({
      status: "completed",
      exitCode: 0,
      timedOut: false,
      token: next.finalizeToken,
    });
  });
});
