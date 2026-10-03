import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { createSandboxBrowserTestHarness } from "./browser.create.test-helpers.js";

describe("managed browser workspace custody", () => {
  const harness = createSandboxBrowserTestHarness();
  const { dockerMocks, registryMocks, buildConfig, ensureTestSandboxBrowser } = harness;

  const browserParams = () => ({
    scopeKey: "session:managed",
    workspaceDir: harness.testWorkspaceDir,
    agentWorkspaceDir: harness.testWorkspaceDir,
    cfg: buildConfig(false),
  });

  it.each([false, true])(
    "rejoins workspace custody for late start (revoked=%s)",
    async (revoked) => {
      let current = true;
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
        ...browserParams(),
        withWorkspace,
        assertCurrent: () => {
          if (!current) {
            throw new Error("browser owner revoked");
          }
        },
      });
      expect(result).not.toBeNull();
      const starts = dockerMocks.execDocker.mock.calls.filter(
        ([args]) => args[0] === "start",
      ).length;
      const callback =
        harness.bridgeMocks.startBrowserBridgeServer.mock.calls[0]?.[0].onEnsureAttachTarget;
      expect(callback).toBeTypeOf("function");
      dockerMocks.dockerContainerState.mockImplementation(async () => {
        expect(owned).toBe(true);
        await Promise.resolve();
        current = !revoked;
        return { exists: true, running: false };
      });
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
      if (revoked) {
        await expect(callback({})).rejects.toThrow("browser owner revoked");
        expect(
          dockerMocks.execDocker.mock.calls.filter(([args]) => args[0] === "start"),
        ).toHaveLength(starts);
      } else {
        await callback({});
      }
      expect(entered).toHaveBeenCalledTimes(2);
    },
  );

  it("replaces the browser bridge when a later admitted turn owns its restart callback", async () => {
    harness.bridgeMocks.startBrowserBridgeServer.mockImplementation(async (params) => ({
      server: { listening: true },
      port: 19000,
      baseUrl: "http://127.0.0.1:19000",
      state: { server: null, port: 19000, resolved: params.resolved, profiles: new Map() },
    }));
    const input = browserParams();
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

  it.each([false, true])(
    "awaits durable custody before allocation (startup fails=%s)",
    async (fails) => {
      if (fails) {
        dockerMocks.readDockerPort.mockResolvedValue(null);
      }
      const started = createDeferred();
      const acknowledgment = createDeferred();
      const assertCurrent = vi.fn();
      const entered = vi.fn();
      registryMocks.updateBrowserRegistry.mockImplementationOnce(async (_entry, guard) => {
        expect(guard).toBe(assertCurrent);
        started.resolve();
        await acknowledgment.promise;
      });
      const operation = ensureTestSandboxBrowser({
        ...browserParams(),
        withWorkspace: async (run) => {
          entered();
          return await run();
        },
        assertCurrent,
      });
      const settled = fails ? expect(operation).rejects.toThrow("port mapping") : operation;
      try {
        await awaitGateBeforeSettlement(started.promise, operation, "reservation was not reached");
        expect(dockerMocks.execDocker.mock.calls.some(([args]) => args[0] === "create")).toBe(
          false,
        );
      } finally {
        acknowledgment.resolve();
        await settled;
      }
      expect(entered).toHaveBeenCalledOnce();
      expect(registryMocks.updateBrowserRegistry.mock.calls[0]?.[0]).toMatchObject({
        workspaceDir: harness.testWorkspaceDir,
        cdpPort: 0,
      });
      const createIndex = dockerMocks.execDocker.mock.calls.findIndex(
        ([args]) => args[0] === "create",
      );
      expect(createIndex).toBeGreaterThanOrEqual(0);
      expect(registryMocks.updateBrowserRegistry.mock.invocationCallOrder[0]!).toBeLessThan(
        dockerMocks.execDocker.mock.invocationCallOrder[createIndex]!,
      );
      expect(registryMocks.updateBrowserRegistry.mock.calls.at(-1)?.[1]).toBe(assertCurrent);
    },
  );
});
