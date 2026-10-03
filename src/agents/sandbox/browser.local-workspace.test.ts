import { createServer } from "node:http";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createSandboxBrowserTestHarness } from "./browser.create.test-helpers.js";
import { captureSandboxStateOwner } from "./state-owner.js";

describe("managed browser workspace custody", () => {
  const harness = createSandboxBrowserTestHarness();
  const { dockerMocks, registryMocks, buildConfig, ensureTestSandboxBrowser } = harness;

  const browserParams = () => ({
    scopeKey: "session:managed",
    workspaceDir: harness.testWorkspaceDir,
    agentWorkspaceDir: harness.testWorkspaceDir,
    cfg: buildConfig(false),
  });

  it.each(["startup", "publication", "publication rejection"] as const)(
    "cleans up a newly started bridge after %s",
    async (phase) => {
      const root = harness.testWorkspaceDir;
      await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
        const owner = acquireGatewayStateOwner({
          databasePath: resolveOpenClawStateSqlitePath(),
          payload: {
            pid: process.pid,
            createdAt: new Date().toISOString(),
            configPath: path.join(root, "openclaw.json"),
            role: "gateway",
          },
        });
        const assertCurrent = await captureSandboxStateOwner();
        const entered = createDeferred();
        const resume = createDeferred();
        const server = createServer();
        const publicationError = new Error("synthetic registry publication failure");
        const waitForRelease = async () => {
          entered.resolve();
          await resume.promise;
          if (phase === "publication rejection") {
            throw publicationError;
          }
        };
        harness.bridgeMocks.startBrowserBridgeServer.mockImplementationOnce(
          async ({ resolved }) => {
            if (phase === "startup") {
              await waitForRelease();
            }
            return { server, port: 19000, baseUrl: "http://127.0.0.1:19000", state: { resolved } };
          },
        );
        if (phase !== "startup") {
          registryMocks.updateBrowserRegistry.mockImplementationOnce(waitForRelease);
        }
        const preparation = ensureTestSandboxBrowser({ ...browserParams(), assertCurrent });
        try {
          await awaitGateBeforeSettlement(
            entered.promise,
            preparation,
            "Bridge lifecycle barrier not reached",
          );
          if (phase !== "publication rejection") {
            owner.release();
          }
          resume.resolve();
          const error = await preparation.catch((failure: unknown) => failure);
          expect(harness.bridgeMocks.stopBrowserBridgeServer).toHaveBeenCalledExactlyOnceWith(
            server,
          );
          expect(harness.BROWSER_BRIDGES.size).toBe(0);
          expect(registryMocks.updateBrowserRegistry).toHaveBeenCalledTimes(
            phase === "startup" ? 0 : 1,
          );
          if (phase === "publication rejection") {
            expect(error).toBe(publicationError);
          } else {
            expect(error).toMatchObject({ code: "GATEWAY_STATE_OWNER_REQUIRED" });
          }
        } finally {
          resume.resolve();
          await preparation.catch(() => {});
          owner.release();
        }
      });
    },
  );

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

  it("rejects hosted custody lost while waiting for CDP readiness", async () => {
    const root = harness.testWorkspaceDir;
    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const owner = acquireGatewayStateOwner({
        databasePath: resolveOpenClawStateSqlitePath(),
        payload: {
          pid: process.pid,
          createdAt: new Date().toISOString(),
          configPath: path.join(root, "openclaw.json"),
          role: "gateway",
        },
      });
      const assertCurrent = await captureSandboxStateOwner();
      const entered = createDeferred();
      const resume = createDeferred();
      try {
        await ensureTestSandboxBrowser({ ...browserParams(), assertCurrent });
        const callback = harness.requireValue(
          harness.bridgeMocks.startBrowserBridgeServer.mock.calls[0]?.[0].onEnsureAttachTarget,
          "browser attach callback",
        );
        dockerMocks.dockerContainerState.mockResolvedValue({ exists: true, running: true });
        vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
          entered.resolve();
          await resume.promise;
          return new Response("{}");
        });
        const attaching = callback({});
        try {
          await awaitGateBeforeSettlement(entered.promise, attaching, "CDP readiness not reached");
          owner.release();
          resume.resolve();
          await expect(attaching).rejects.toMatchObject({ code: "GATEWAY_STATE_OWNER_REQUIRED" });
        } finally {
          resume.resolve();
          await attaching.catch(() => {});
        }
      } finally {
        owner.release();
      }
    });
  });

  it.each([true, false])(
    "replaces guarded browser restart callbacks (managed workspace=%s)",
    async (managed) => {
      harness.bridgeMocks.startBrowserBridgeServer.mockImplementation(async (params) => ({
        server: { listening: true },
        port: 19000,
        baseUrl: "http://127.0.0.1:19000",
        state: { server: null, port: 19000, resolved: params.resolved, profiles: new Map() },
      }));
      const input = browserParams();
      let firstCurrent = true;
      const assertCurrent = () => {
        if (!firstCurrent) {
          throw new Error("first turn closed");
        }
      };
      await ensureTestSandboxBrowser({
        ...input,
        ...(managed
          ? {
              withWorkspace: async <T>(run: () => Promise<T>) => {
                assertCurrent();
                return await run();
              },
            }
          : { assertCurrent }),
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
      await ensureTestSandboxBrowser({
        ...input,
        ...(managed
          ? { withWorkspace: async <T>(run: () => Promise<T>) => await run() }
          : { assertCurrent: () => {} }),
      });
      expect(harness.bridgeMocks.stopBrowserBridgeServer).toHaveBeenCalledOnce();
      expect(harness.bridgeMocks.startBrowserBridgeServer).toHaveBeenCalledTimes(2);
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
      await harness.bridgeMocks.startBrowserBridgeServer.mock.calls[1]?.[0].onEnsureAttachTarget(
        {},
      );
    },
  );

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
