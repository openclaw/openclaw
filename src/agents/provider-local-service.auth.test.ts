import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
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
const currentPid = () => getManagedProviderLocalServiceDiagnosticsForTest()[0]?.pid;
const headers = (key: string) => ({ Authorization: `Bearer ${key}` });

async function createFixture() {
  const state = {
    current: true,
    started: false,
    unhealthy: false,
    revokeOn: "" as "" | "retry",
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
  const origin = await listenLoopback(server);
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
    acquire: (key?: string, target = model) =>
      ensureModelProviderLocalService(target, key ? headers(key) : undefined),
    async close() {
      await stopManagedProviderLocalServices();
      await closeHttpServer(server);
    },
  };
}

describe("local service credential authority", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;
  beforeEach(async () => {
    fixture = await createFixture();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture.close();
  });

  it.each(["initial", "start", "stop", "retry"] as const)(
    "makes no credential-bearing health requests after revocation during %s",
    async (phase) => {
      const { state, acquire } = fixture;
      let previousPid: number | undefined;
      if (phase === "stop") {
        const lease = await acquire();
        previousPid = currentPid();
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
      } else if (phase === "start") {
        const track = localServiceProcess.trackLocalServiceProcess;
        vi.spyOn(localServiceProcess, "trackLocalServiceProcess").mockImplementation((child) => {
          const owned = track(child);
          // Revoke after spawn, before readiness dispatch. A child HTTP notification
          // can arrive after an already-authorized health request is in flight.
          state.current = false;
          return owned;
        });
      } else {
        state.revokeOn = phase;
      }
      await expect(acquire("fixture-key")).rejects.toThrow(retired);
      expect(state).toMatchObject({ current: false, revokedProbes: 0 });
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
    const { state, model, acquire } = fixture;
    const firstLease = await acquire();
    const pid = currentPid();
    expect(pid).toBeDefined();
    const probes = state.probes.length;
    const revokedModel = attachProviderAuthAuthority(model, () => {
      throw new Error(retired);
    });
    await expect(acquire("retired-key", revokedModel)).rejects.toThrow(retired);
    expect(state.probes).toHaveLength(probes);
    expect(currentPid()).toBe(pid);
    expect(isPidAlive(pid!)).toBe(true);
    const secondLease = await acquire();
    expect(secondLease).toBeDefined();
    firstLease?.release();
    expect(isPidAlive(pid!)).toBe(true);
    secondLease?.release();
  });

  it("settles shared startup before admitting an independently healthy caller", async () => {
    const { state, model, acquire } = fixture;
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
    const first = acquire("startup-key");
    const firstRejected = expect(first).rejects.toThrow(retired);
    await readinessEntered.promise;
    const independent = attachProviderAuthAuthority(model, () => {});
    const second = acquire("independent-key", independent);
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
      const { state, acquire } = fixture;
      state.onProbe = (request, response) => {
        if (request.url === "/v1/models") {
          state.current = !revoke;
          response.writeHead(302, { location: "/healthy" });
        }
        response.end("ok");
        return true;
      };
      const acquisition = acquire("redirect-key");
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
    const { state, model, acquire } = fixture;
    const firstLease = await acquire();
    const pid = currentPid();
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
      headers: headers("fixture-key"),
      body: "{}",
    });
    const rejected = expect(pending).rejects.toThrow(retired);
    await entered.promise;
    state.current = false;
    reconciled.resolve();
    await rejected;
    expect(state).toMatchObject({ modelRequests: 0, revokedProbes: 0 });
    expect(currentPid()).toBe(pid);
    expect(isPidAlive(pid!)).toBe(true);
    firstLease?.release();
  });
});
