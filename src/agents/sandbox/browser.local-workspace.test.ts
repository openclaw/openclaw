import { describe, expect, it, vi } from "vitest";
import { createSandboxBrowserTestHarness } from "./browser.create.test-helpers.js";

describe("managed browser workspace custody", () => {
  const harness = createSandboxBrowserTestHarness();
  const { dockerMocks, registryMocks, buildConfig, ensureTestSandboxBrowser } = harness;

  it("does not restart a browser after authority closes during container inspection", async () => {
    let current = true;
    await ensureTestSandboxBrowser({
      scopeKey: "session:revoked-browser",
      workspaceDir: harness.testWorkspaceDir,
      agentWorkspaceDir: harness.testWorkspaceDir,
      cfg: buildConfig(false),
      withWorkspace: async (run) => await run(),
      assertCurrent: () => {
        if (!current) {
          throw new Error("browser owner revoked");
        }
      },
    });
    const starts = dockerMocks.execDocker.mock.calls.filter(([args]) => args[0] === "start").length;
    const callback =
      harness.bridgeMocks.startBrowserBridgeServer.mock.calls[0]?.[0].onEnsureAttachTarget;
    dockerMocks.dockerContainerState.mockImplementation(async () => {
      await Promise.resolve();
      current = false;
      return { exists: true, running: false };
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await expect(callback({})).rejects.toThrow("browser owner revoked");
    expect(dockerMocks.execDocker.mock.calls.filter(([args]) => args[0] === "start")).toHaveLength(
      starts,
    );
  });

  it("rejoins workspace custody before a late browser start", async () => {
    let owned = false;
    const entered = vi.fn();
    const withWorkspace = async <T>(run: () => Promise<T>) => {
      entered();
      expect(owned).toBe(false);
      owned = true;
      try {
        return await run();
      } finally {
        owned = false;
      }
    };
    const result = await ensureTestSandboxBrowser({
      scopeKey: "session:managed",
      workspaceDir: harness.testWorkspaceDir,
      agentWorkspaceDir: harness.testWorkspaceDir,
      cfg: buildConfig(false),
      withWorkspace,
    });
    expect(result).not.toBeNull();
    const callback =
      harness.bridgeMocks.startBrowserBridgeServer.mock.calls[0]?.[0].onEnsureAttachTarget;
    expect(callback).toBeTypeOf("function");
    dockerMocks.dockerContainerState.mockImplementation(async () => {
      expect(owned).toBe(true);
      return { exists: true, running: false };
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await callback({});
    expect(entered).toHaveBeenCalledTimes(2);
  });

  it("replaces the browser bridge when a later admitted turn owns its restart callback", async () => {
    harness.bridgeMocks.startBrowserBridgeServer.mockImplementation(async (params) => ({
      server: { listening: true },
      port: 19000,
      baseUrl: "http://127.0.0.1:19000",
      state: { server: null, port: 19000, resolved: params.resolved, profiles: new Map() },
    }));
    const input = {
      scopeKey: "session:managed",
      workspaceDir: harness.testWorkspaceDir,
      agentWorkspaceDir: harness.testWorkspaceDir,
      cfg: buildConfig(false),
    };
    let firstCurrent = true;
    await ensureTestSandboxBrowser({
      ...input,
      withWorkspace: async (run) => {
        if (!firstCurrent) {
          throw new Error("first turn closed");
        }
        return await run();
      },
    });
    const token = harness
      .requireDockerCreateEnvEntries()
      .find((entry) => entry.startsWith("OPENCLAW_BROWSER_CDP_AUTH_TOKEN="))!
      .split("=")[1]!;
    const recorded = registryMocks.updateBrowserRegistry.mock.calls.at(-1)?.[0];
    dockerMocks.dockerContainerState.mockResolvedValue({ exists: true, running: true });
    dockerMocks.readDockerContainerEnvVar.mockResolvedValue(token);
    dockerMocks.readDockerContainerLabel.mockResolvedValue(recorded.configHash);
    registryMocks.readBrowserRegistry.mockResolvedValue({ entries: [recorded] });
    firstCurrent = false;
    await ensureTestSandboxBrowser({ ...input, withWorkspace: async (run) => await run() });
    expect(harness.bridgeMocks.stopBrowserBridgeServer).toHaveBeenCalledOnce();
    expect(harness.bridgeMocks.startBrowserBridgeServer).toHaveBeenCalledTimes(2);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await harness.bridgeMocks.startBrowserBridgeServer.mock.calls[1]?.[0].onEnsureAttachTarget({});
  });

  it("retains managed workspace custody when browser startup fails after allocation", async () => {
    dockerMocks.readDockerPort.mockResolvedValue(null);
    const entered = vi.fn();
    const withWorkspace = async <T>(run: () => Promise<T>) => {
      entered();
      return await run();
    };
    await expect(
      ensureTestSandboxBrowser({
        scopeKey: "session:managed",
        workspaceDir: harness.testWorkspaceDir,
        agentWorkspaceDir: harness.testWorkspaceDir,
        cfg: buildConfig(false),
        withWorkspace,
      }),
    ).rejects.toThrow("port mapping");
    expect(entered).toHaveBeenCalledOnce();
    const reserved = registryMocks.updateBrowserRegistry.mock.calls[0]?.[0];
    expect(reserved).toMatchObject({ workspaceDir: harness.testWorkspaceDir, cdpPort: 0 });
    const reserveOrder = registryMocks.updateBrowserRegistry.mock.invocationCallOrder[0]!;
    const createIndex = dockerMocks.execDocker.mock.calls.findIndex(
      ([args]) => args[0] === "create",
    );
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(reserveOrder).toBeLessThan(
      dockerMocks.execDocker.mock.invocationCallOrder[createIndex]!,
    );
  });
});
