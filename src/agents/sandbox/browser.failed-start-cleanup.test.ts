import { describe, expect, it, vi } from "vitest";
import { createSandboxBrowserTestHarness } from "./browser.create.test-helpers.js";
import { findDockerArgsCall } from "./test-args.js";

const CONTAINER_NAME = "openclaw-sbx-browser-session-test-0661d10a";

describe("ensureSandboxBrowser failed start cleanup", () => {
  const harness = createSandboxBrowserTestHarness();
  const { dockerMocks, registryMocks, bridgeMocks, runtimeMocks, buildConfig } = harness;

  const freshParams = () => ({
    scopeKey: "session:test",
    workspaceDir: harness.testWorkspaceDir,
    agentWorkspaceDir: harness.testWorkspaceDir,
    cfg: buildConfig(false),
  });

  const removeCalls = () =>
    dockerMocks.execDocker.mock.calls.filter(
      ([args]) => args[0] === "rm" && args[1] === "-f" && args[2] === CONTAINER_NAME,
    );

  const dockerCallIndex = (command: string) =>
    dockerMocks.execDocker.mock.calls.findIndex(([args]) => args[0] === command);

  /** Layers one command override on top of the harness's default Docker behavior. */
  const overrideDockerCommand = (
    command: string,
    handler: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>,
  ) => {
    const base = dockerMocks.execDocker.getMockImplementation();
    if (!base) {
      throw new Error("expected the harness docker mock implementation");
    }
    dockerMocks.execDocker.mockImplementation(async (args: string[]) =>
      args[0] === command ? await handler(args) : await base(args),
    );
  };

  it("removes a container this attempt created when bridge startup fails before publication", async () => {
    bridgeMocks.startBrowserBridgeServer.mockRejectedValueOnce(
      new Error("plugin runtime is not active"),
    );

    await expect(harness.ensureTestSandboxBrowser(freshParams())).rejects.toThrow(
      "plugin runtime is not active",
    );

    expect(removeCalls()).toHaveLength(1);
    expect(dockerCallIndex("rm")).toBeGreaterThan(dockerCallIndex("create"));
    expect(registryMocks.updateBrowserRegistry).not.toHaveBeenCalled();
    expect(harness.BROWSER_BRIDGES.has("session:test")).toBe(false);
    expect(runtimeMocks.error).not.toHaveBeenCalled();
  });

  it("removes a container this attempt created when the CDP port mapping is missing", async () => {
    dockerMocks.readDockerPort.mockResolvedValue(null);

    await expect(harness.ensureTestSandboxBrowser(freshParams())).rejects.toThrow(
      "Failed to resolve CDP port mapping",
    );

    expect(removeCalls()).toHaveLength(1);
    expect(dockerCallIndex("rm")).toBeGreaterThan(dockerCallIndex("create"));
    expect(bridgeMocks.startBrowserBridgeServer).not.toHaveBeenCalled();
    expect(registryMocks.updateBrowserRegistry).not.toHaveBeenCalled();
  });

  it("removes a container this attempt created when docker start fails", async () => {
    overrideDockerCommand("start", async () => {
      throw new Error("synthetic docker start failure");
    });

    await expect(harness.ensureTestSandboxBrowser(freshParams())).rejects.toThrow(
      "synthetic docker start failure",
    );

    expect(removeCalls()).toHaveLength(1);
    expect(dockerCallIndex("rm")).toBeGreaterThan(dockerCallIndex("create"));
  });

  it("keeps a pre-existing running container when bridge startup fails", async () => {
    const common = freshParams();
    await harness.ensureTestSandboxBrowser(common);
    harness.reuseCreatedBrowser();
    dockerMocks.execDocker.mockClear();
    bridgeMocks.startBrowserBridgeServer.mockRejectedValueOnce(
      new Error("plugin runtime is not active"),
    );

    // A changed evaluate policy forces a bridge restart against the existing container.
    await expect(
      harness.ensureTestSandboxBrowser({ ...common, evaluateEnabled: false }),
    ).rejects.toThrow("plugin runtime is not active");

    expect(findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create")).toBeUndefined();
    expect(removeCalls()).toHaveLength(0);
  });

  it("keeps a managed-workspace container that was reserved before allocation", async () => {
    bridgeMocks.startBrowserBridgeServer.mockRejectedValueOnce(
      new Error("plugin runtime is not active"),
    );

    await expect(
      harness.ensureTestSandboxBrowser({
        ...freshParams(),
        withWorkspace: async (run) => await run(),
      }),
    ).rejects.toThrow("plugin runtime is not active");

    expect(registryMocks.updateBrowserRegistry.mock.calls[0]?.[0]).toMatchObject({
      containerName: CONTAINER_NAME,
      cdpPort: 0,
    });
    expect(registryMocks.updateBrowserRegistry.mock.invocationCallOrder[0]!).toBeLessThan(
      dockerMocks.execDocker.mock.invocationCallOrder[dockerCallIndex("create")]!,
    );
    expect(removeCalls()).toHaveLength(0);
  });

  it("removes a container this attempt created when registry publication is rejected", async () => {
    registryMocks.updateBrowserRegistry.mockRejectedValueOnce(
      new Error("synthetic registry publication failure"),
    );

    await expect(harness.ensureTestSandboxBrowser(freshParams())).rejects.toThrow(
      "synthetic registry publication failure",
    );

    expect(removeCalls()).toHaveLength(1);
    expect(bridgeMocks.stopBrowserBridgeServer).toHaveBeenCalledOnce();
    expect(harness.BROWSER_BRIDGES.has("session:test")).toBe(false);
  });

  it("keeps a published container when a later check fails", async () => {
    let published = false;
    registryMocks.updateBrowserRegistry.mockImplementationOnce(async () => {
      published = true;
    });
    const assertCurrent = vi.fn(() => {
      if (published) {
        throw new Error("synthetic custody loss after publication");
      }
    });

    await expect(
      harness.ensureTestSandboxBrowser({ ...freshParams(), assertCurrent }),
    ).rejects.toThrow("synthetic custody loss after publication");

    expect(registryMocks.updateBrowserRegistry).toHaveBeenCalledOnce();
    expect(removeCalls()).toHaveLength(0);
  });

  it("reports a removal that exits non-zero and still surfaces the startup error", async () => {
    overrideDockerCommand("rm", async () => ({
      stdout: "",
      stderr: "synthetic docker rm failure",
      code: 1,
    }));
    bridgeMocks.startBrowserBridgeServer.mockRejectedValueOnce(
      new Error("plugin runtime is not active"),
    );

    await expect(harness.ensureTestSandboxBrowser(freshParams())).rejects.toThrow(
      "plugin runtime is not active",
    );

    expect(removeCalls()).toHaveLength(1);
    expect(runtimeMocks.error).toHaveBeenCalledWith(
      expect.stringContaining(`failed to remove ${CONTAINER_NAME}`),
    );
    expect(runtimeMocks.error).toHaveBeenCalledWith(
      expect.stringContaining("synthetic docker rm failure"),
    );
  });

  it("reports a removal that throws and still surfaces the startup error", async () => {
    overrideDockerCommand("rm", async () => {
      throw new Error("synthetic docker daemon failure");
    });
    bridgeMocks.startBrowserBridgeServer.mockRejectedValueOnce(
      new Error("plugin runtime is not active"),
    );

    await expect(harness.ensureTestSandboxBrowser(freshParams())).rejects.toThrow(
      "plugin runtime is not active",
    );

    expect(removeCalls()).toHaveLength(1);
    expect(runtimeMocks.error).toHaveBeenCalledWith(
      expect.stringContaining(`failed to remove ${CONTAINER_NAME}`),
    );
    expect(runtimeMocks.error).toHaveBeenCalledWith(
      expect.stringContaining("synthetic docker daemon failure"),
    );
  });

  const hungContainerSetup = () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        ({
          ok: false,
          body: { cancel: vi.fn().mockResolvedValue(undefined) },
        }) as never,
    );
    bridgeMocks.startBrowserBridgeServer.mockImplementationOnce(async (params) => {
      await params.onEnsureAttachTarget?.({});
      throw new Error("probe completed before bridge creation");
    });
    const cfg = buildConfig(false);
    cfg.browser.autoStartTimeoutMs = 50;
    return cfg;
  };

  it("removes a hung container exactly once after the CDP startup timeout", async () => {
    const cfg = hungContainerSetup();

    await expect(harness.ensureTestSandboxBrowser({ ...freshParams(), cfg })).rejects.toThrow(
      "The hung container has been forcefully removed.",
    );

    expect(removeCalls()).toHaveLength(1);
    expect(runtimeMocks.error).not.toHaveBeenCalled();
  });

  it("reports a failed hung-container removal instead of claiming success", async () => {
    const cfg = hungContainerSetup();
    overrideDockerCommand("rm", async () => ({
      stdout: "",
      stderr: "synthetic docker rm failure",
      code: 1,
    }));

    await expect(harness.ensureTestSandboxBrowser({ ...freshParams(), cfg })).rejects.toThrow(
      `Removing the hung container failed; remove it with \`docker rm -f ${CONTAINER_NAME}\`.`,
    );

    expect(removeCalls()).toHaveLength(1);
    expect(runtimeMocks.error).toHaveBeenCalledWith(
      expect.stringContaining(`failed to remove ${CONTAINER_NAME}`),
    );
  });

  it.each([
    { removal: "succeeds", code: 0, message: "The hung container has been forcefully removed." },
    {
      removal: "fails",
      code: 1,
      message: `Removing the hung container failed; remove it with \`docker rm -f ${CONTAINER_NAME}\`.`,
    },
  ])(
    "late attachment to a hung container removes it once and reports that removal $removal",
    async ({ code, message }) => {
      const cfg = buildConfig(false);
      cfg.browser.autoStartTimeoutMs = 50;
      await harness.ensureTestSandboxBrowser({ ...freshParams(), cfg });
      const attach = harness.requireValue(
        bridgeMocks.startBrowserBridgeServer.mock.calls[0]?.[0].onEnsureAttachTarget,
        "bridge attach callback",
      );
      dockerMocks.execDocker.mockClear();
      overrideDockerCommand("rm", async () => ({
        stdout: "",
        stderr: code === 0 ? "" : "synthetic docker rm failure",
        code,
      }));
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          ({
            ok: false,
            body: { cancel: vi.fn().mockResolvedValue(undefined) },
          }) as never,
      );

      // The bridge calls back after startup returned, as a real late attach does.
      await expect(attach({})).rejects.toThrow(message);

      expect(removeCalls()).toHaveLength(1);
      if (code === 0) {
        expect(runtimeMocks.error).not.toHaveBeenCalled();
      } else {
        expect(runtimeMocks.error).toHaveBeenCalledWith(
          expect.stringContaining(`failed to remove ${CONTAINER_NAME}`),
        );
      }
    },
  );

  it("treats an already-removed container as cleaned up", async () => {
    overrideDockerCommand("rm", async () => ({
      stdout: "",
      stderr: `Error response from daemon: No such container: ${CONTAINER_NAME}`,
      code: 1,
    }));
    bridgeMocks.startBrowserBridgeServer.mockRejectedValueOnce(
      new Error("plugin runtime is not active"),
    );

    await expect(harness.ensureTestSandboxBrowser(freshParams())).rejects.toThrow(
      "plugin runtime is not active",
    );

    expect(removeCalls()).toHaveLength(1);
    expect(runtimeMocks.error).not.toHaveBeenCalled();
  });
});
