import { createServer } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { readGatewayLockProcessNamespace } from "../../infra/gateway-lock-payload.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createSandboxBrowserTestHarness } from "./browser.create.test-helpers.js";
import { captureSandboxStateOwner } from "./state-owner.js";

describe("managed browser workspace custody", () => {
  const harness = createSandboxBrowserTestHarness("session:managed");
  const {
    dockerMocks: { execDocker, dockerContainerState },
    registryMocks: { updateBrowserRegistry },
    bridgeMocks: { startBrowserBridgeServer, stopBrowserBridgeServer },
    ensureTestSandboxBrowser,
    bridgeFixture,
    reuseCreatedBrowser,
  } = harness;
  const dockerCalls = (command: string) =>
    execDocker.mock.calls.filter(([args]) => args[0] === command);
  const attach = (index = 0) => {
    const callback = startBrowserBridgeServer.mock.calls[index]?.[0].onEnsureAttachTarget;
    expect(callback).toBeTypeOf("function");
    return expectDefined(callback, "browser attach callback")({});
  };
  const custody = (managed: boolean, assertCurrent: () => void) =>
    managed
      ? {
          withWorkspace: async <T>(run: () => Promise<T>) => {
            assertCurrent();
            return await run();
          },
        }
      : { assertCurrent };

  it.each(["startup", "publication", "publication rejection", "CDP readiness"] as const)(
    "rejects lost custody or failed publication at %s",
    async (phase) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: harness.testWorkspaceDir }, async () => {
        const owner = acquireGatewayStateOwner({
          databasePath: resolveOpenClawStateSqlitePath(),
          payload: {
            pid: process.pid,
            processNamespace: readGatewayLockProcessNamespace(),
            createdAt: new Date().toISOString(),
            configPath: "openclaw.json",
            role: "gateway",
          },
        });
        const entered = createDeferred();
        const resume = createDeferred();
        const publicationError = new Error("synthetic registry publication failure");
        const waitForRelease = async () => {
          entered.resolve();
          await resume.promise;
          if (phase === "publication rejection") {
            throw publicationError;
          }
        };
        const server = createServer();
        const assertCurrent = await captureSandboxStateOwner();
        let preparation: Promise<unknown> | undefined;
        try {
          if (phase === "CDP readiness") {
            await ensureTestSandboxBrowser({ assertCurrent });
            dockerContainerState.mockResolvedValue({ exists: true, running: true });
            vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
              await waitForRelease();
              return new Response("{}");
            });
            preparation = Promise.resolve(attach());
          } else {
            startBrowserBridgeServer.mockImplementationOnce(async ({ resolved }) => {
              if (phase === "startup") {
                await waitForRelease();
              }
              return { ...bridgeFixture(resolved), server };
            });
            if (phase !== "startup") {
              updateBrowserRegistry.mockImplementationOnce(waitForRelease);
            }
            preparation = ensureTestSandboxBrowser({ assertCurrent });
          }
          await awaitGateBeforeSettlement(
            entered.promise,
            preparation,
            "Browser lifecycle barrier not reached",
          );
          if (phase !== "publication rejection") {
            owner.release();
          }
          resume.resolve();
          const error = await preparation.catch((failure: unknown) => failure);
          if (phase !== "CDP readiness") {
            expect(stopBrowserBridgeServer).toHaveBeenCalledExactlyOnceWith(server);
            expect(harness.BROWSER_BRIDGES.size).toBe(0);
            expect(updateBrowserRegistry).toHaveBeenCalledTimes(phase === "startup" ? 0 : 1);
          }
          if (phase === "publication rejection") {
            expect(error).toBe(publicationError);
          } else {
            expect(error).toMatchObject({ code: "GATEWAY_STATE_OWNER_REQUIRED" });
          }
        } finally {
          resume.resolve();
          await preparation?.catch(() => {});
          owner.release();
        }
      });
    },
  );

  it.each([false, true])("rejoins custody for late start (revoked=%s)", async (revoked) => {
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
      withWorkspace,
      assertCurrent: () => {
        if (!current) {
          throw new Error("browser owner revoked");
        }
      },
    });
    expect(result).not.toBeNull();
    const starts = dockerCalls("start").length;
    dockerContainerState.mockImplementation(async () => {
      expect(owned).toBe(true);
      await Promise.resolve();
      current = !revoked;
      return { exists: true, running: false };
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    if (revoked) {
      await expect(attach()).rejects.toThrow("browser owner revoked");
      expect(dockerCalls("start")).toHaveLength(starts);
    } else {
      await attach();
    }
    expect(entered).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])("replaces guarded restart callbacks (managed=%s)", async (managed) => {
    startBrowserBridgeServer.mockImplementation(async ({ resolved }) => bridgeFixture(resolved));
    let firstCurrent = true;
    const assertCurrent = () => {
      if (!firstCurrent) {
        throw new Error("first turn closed");
      }
    };
    await ensureTestSandboxBrowser(custody(managed, assertCurrent));
    reuseCreatedBrowser();
    firstCurrent = false;
    await ensureTestSandboxBrowser(custody(managed, () => {}));
    expect(stopBrowserBridgeServer).toHaveBeenCalledOnce();
    expect(startBrowserBridgeServer).toHaveBeenCalledTimes(2);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await attach(1);
  });

  it("awaits durable custody before allocation even when startup fails", async () => {
    harness.dockerMocks.readDockerPort.mockResolvedValue(null);
    const started = createDeferred();
    const acknowledgment = createDeferred();
    const assertCurrent = vi.fn();
    const entered = vi.fn();
    updateBrowserRegistry.mockImplementationOnce(async (_entry, guard) => {
      expect(guard).toBe(assertCurrent);
      started.resolve();
      await acknowledgment.promise;
    });
    const operation = ensureTestSandboxBrowser({
      withWorkspace: async (run) => {
        entered();
        return await run();
      },
      assertCurrent,
    });
    const settled = expect(operation).rejects.toThrow("port mapping");
    try {
      await awaitGateBeforeSettlement(started.promise, operation, "reservation was not reached");
      expect(dockerCalls("create")).toHaveLength(0);
    } finally {
      acknowledgment.resolve();
      await settled;
    }
    expect(entered).toHaveBeenCalledOnce();
    expect(updateBrowserRegistry.mock.calls[0]?.[0]).toMatchObject({
      workspaceDir: harness.testWorkspaceDir,
      cdpPort: 0,
    });
    const createIndex = execDocker.mock.calls.findIndex(([args]) => args[0] === "create");
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(updateBrowserRegistry.mock.invocationCallOrder[0]!).toBeLessThan(
      execDocker.mock.invocationCallOrder[createIndex]!,
    );
    expect(updateBrowserRegistry.mock.calls.at(-1)?.[1]).toBe(assertCurrent);
  });
});
