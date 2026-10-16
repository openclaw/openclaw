import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachProviderAuthAuthority } from "../plugins/provider-auth-authority.js";
import { attachModelProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { isPidAlive } from "../shared/pid-alive.js";
import * as localServiceProcess from "./provider-local-service-process.js";
import {
  attachModelProviderLocalService,
  ensureModelProviderLocalService,
  getManagedProviderLocalServiceDiagnosticsForTest,
  stopManagedProviderLocalServices,
} from "./provider-local-service.js";
import { hasManagedProviderLocalServices } from "./provider-runtime-lifecycle.js";
import { buildGuardedModelFetch } from "./provider-transport-fetch.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const retired = "fixture credential owner retired";

async function createFixture() {
  const state = {
    current: true,
    started: false,
    unhealthy: false,
    revokeOn: "" as "" | "start" | "retry",
    probes: [] as string[],
    revokedProbes: 0,
    modelRequests: 0,
    onProbe: undefined as
      | ((request: IncomingMessage, response: ServerResponse) => boolean)
      | undefined,
  };
  const server = createServer((request, response) => {
    if (request.url === "/started") {
      state.started = true;
      if (state.revokeOn === "start") {
        state.current = false;
      }
    } else if (request.url === "/v1/models" || request.url === "/healthy") {
      state.probes.push(request.headers.authorization ?? "");
      if (!state.current) {
        state.revokedProbes += 1;
      }
      if (state.started && state.revokeOn === "retry") {
        state.current = false;
      }
      if (state.onProbe?.(request, response)) {
        return;
      }
      response.statusCode = state.started && !state.unhealthy ? 200 : 503;
    } else {
      state.modelRequests += 1;
    }
    response.end("ok");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing fixture address");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  const model = attachProviderAuthAuthority(
    attachModelProviderLocalService(
      makeProviderModelFixture({
        id: "fixture-model",
        provider: "local-auth-fixture",
        api: "openai-completions",
        baseUrl: `${origin}/v1`,
      }),
      {
        command: process.execPath,
        args: [
          "-e",
          `require("node:http").get(${JSON.stringify(`${origin}/started`)},r=>r.resume());setInterval(()=>{},1000);`,
        ],
        readyTimeoutMs: 5_000,
      },
    ),
    () => {
      if (!state.current) {
        throw new Error(retired);
      }
    },
  );
  return {
    state,
    model,
    async close() {
      await stopManagedProviderLocalServices();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe("local service credential authority", () => {
  const fixtures: Awaited<ReturnType<typeof createFixture>>[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const fixture of fixtures.splice(0)) {
      await fixture.close();
    }
  });
  const fixture = async () => {
    const result = await createFixture();
    fixtures.push(result);
    return result;
  };

  it.each(["initial", "start", "stop", "retry"] as const)(
    "makes no credential-bearing health requests after revocation during %s",
    async (phase) => {
      const { state, model } = await fixture();
      let previousPid: number | undefined;
      if (phase === "stop") {
        const lease = await ensureModelProviderLocalService(model);
        previousPid = getManagedProviderLocalServiceDiagnosticsForTest()[0]?.pid;
        expect(previousPid).toBeDefined();
        lease?.release();
      }
      state.unhealthy = true;
      if (phase === "initial") {
        state.current = false;
      } else if (phase === "stop") {
        const stop = localServiceProcess.stopLocalServiceProcess;
        vi.spyOn(localServiceProcess, "stopLocalServiceProcess").mockImplementation(
          async (owned) => {
            await stop(owned);
            state.current = false;
          },
        );
      } else {
        state.revokeOn = phase;
      }
      await expect(
        ensureModelProviderLocalService(model, { Authorization: "Bearer fixture-key" }),
      ).rejects.toThrow(retired);
      expect(state.current).toBe(false);
      expect(state.revokedProbes).toBe(0);
      if (phase === "initial") {
        expect(state.probes).toEqual([]);
      } else {
        expect(state.probes).toContain("Bearer fixture-key");
      }
      expect(hasManagedProviderLocalServices()).toBe(false);
      expect(getManagedProviderLocalServiceDiagnosticsForTest()).toEqual([]);
      if (previousPid !== undefined) {
        expect(isPidAlive(previousPid)).toBe(false);
      }
    },
  );

  it("keeps another caller's healthy process and lease when a credential is revoked", async () => {
    const { state, model } = await fixture();
    const firstLease = await ensureModelProviderLocalService(model);
    const pid = getManagedProviderLocalServiceDiagnosticsForTest()[0]?.pid;
    expect(pid).toBeDefined();
    const probes = state.probes.length;
    const revokedModel = attachProviderAuthAuthority(model, () => {
      throw new Error(retired);
    });
    await expect(
      ensureModelProviderLocalService(revokedModel, { Authorization: "Bearer retired-key" }),
    ).rejects.toThrow(retired);
    expect(state.probes).toHaveLength(probes);
    expect(getManagedProviderLocalServiceDiagnosticsForTest()[0]?.pid).toBe(pid);
    expect(isPidAlive(pid!)).toBe(true);
    const secondLease = await ensureModelProviderLocalService(model);
    expect(secondLease).toBeDefined();
    firstLease?.release();
    expect(isPidAlive(pid!)).toBe(true);
    secondLease?.release();
  });

  it("settles shared startup before admitting an independently healthy caller", async () => {
    const { state, model } = await fixture();
    const readinessEntered = createDeferredCore();
    const readinessReleased = createDeferredCore();
    const secondProbe = createDeferredCore();
    let heldReadiness = false;
    state.onProbe = (request, response) => {
      if (request.headers.authorization === "Bearer independent-key") {
        response.end("ok");
        secondProbe.resolve();
        return true;
      }
      if (state.started && !heldReadiness) {
        heldReadiness = true;
        readinessEntered.resolve();
        void readinessReleased.promise.then(() => {
          response.statusCode = 503;
          response.end("still starting");
        });
        return true;
      }
      return false;
    };
    const first = ensureModelProviderLocalService(model, {
      Authorization: "Bearer startup-key",
    });
    const firstRejected = expect(first).rejects.toThrow(retired);
    await readinessEntered.promise;
    const independent = attachProviderAuthAuthority(model, () => {});
    const second = ensureModelProviderLocalService(independent, {
      Authorization: "Bearer independent-key",
    });
    const settled = Promise.allSettled([first, second]);
    await secondProbe.promise;
    state.current = false;
    readinessReleased.resolve();
    await firstRejected;
    const results = await settled;
    expect(results[1]?.status).toBe("rejected");
    expect(hasManagedProviderLocalServices()).toBe(false);
  });

  it.each([false, true])(
    "revalidates every health redirect while preserving a live credential (revoke=%s)",
    async (revoke) => {
      const { state, model } = await fixture();
      state.onProbe = (request, response) => {
        if (request.url === "/v1/models") {
          state.current = !revoke;
          response.writeHead(302, { location: "/healthy" });
        }
        response.end("ok");
        return true;
      };
      const acquisition = ensureModelProviderLocalService(model, {
        Authorization: "Bearer redirect-key",
      });
      if (revoke) {
        await expect(acquisition).rejects.toThrow(retired);
        expect(state.probes).toEqual(["Bearer redirect-key"]);
      } else {
        const lease = await acquisition;
        expect(lease).toBeDefined();
        expect(state.probes).toEqual(["Bearer redirect-key", "Bearer redirect-key"]);
        lease?.release();
      }
      expect(state.revokedProbes).toBe(0);
    },
  );

  it("rejects after deferred reconciliation without sending a model request or losing another lease", async () => {
    const { state, model } = await fixture();
    const firstLease = await ensureModelProviderLocalService(model);
    const pid = getManagedProviderLocalServiceDiagnosticsForTest()[0]?.pid;
    const entered = createDeferredCore();
    const reconciled = createDeferredCore();
    const target = attachModelProviderRuntimePluginHandle(model, {
      plugin: {
        reconcileLocalService: async () => {
          entered.resolve();
          await reconciled.promise;
        },
      },
    } as never);
    const pending = buildGuardedModelFetch(target)(`${target.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer fixture-key" },
      body: "{}",
    });
    const rejected = expect(pending).rejects.toThrow(retired);
    await entered.promise;
    state.current = false;
    reconciled.resolve();
    await rejected;
    expect(state.modelRequests).toBe(0);
    expect(state.revokedProbes).toBe(0);
    expect(getManagedProviderLocalServiceDiagnosticsForTest()[0]?.pid).toBe(pid);
    expect(isPidAlive(pid!)).toBe(true);
    firstLease?.release();
  });
});
