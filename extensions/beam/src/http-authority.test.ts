import { ServerResponse } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createMockIncomingRequest } from "openclaw/plugin-sdk/test-env";
import { assert, expect, it, onTestFinished, vi } from "vitest";
import { memoryStore, sampleUpload } from "./beam-store.test-support.js";
import { createBeamRequestHandler } from "./http.js";
import type { BeamStoredSession } from "./types.js";

const requestScope = vi.hoisted(() => ({
  client: { clientIp: "127.0.0.1", connect: { scopes: ["operator.write"] } },
  revalidate: vi.fn<() => Promise<void>>(),
}));
// mock-isolation: These fixtures replace only the admitted request owner, including revalidation.
vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getPluginRuntimeGatewayRequestScope: () => requestScope,
}));

function uploadRequest() {
  const store = memoryStore();
  const req = createMockIncomingRequest([JSON.stringify(sampleUpload())]);
  req.method = "POST";
  req.headers["content-type"] = "application/json";
  const res = new ServerResponse(req);
  onTestFinished(() => {
    req.destroy();
    res.destroy();
  });
  requestScope.revalidate.mockReset().mockResolvedValue(undefined);
  const handler = createBeamRequestHandler({
    store,
    now: () => 100,
    resolveControlUiBasePath: () => undefined,
  });
  return { store, res, run: () => handler(req, res) };
}

it.each(["current", "observation", "conflict"] as const)(
  "publishes only with current request authority: %s",
  async (phase) => {
    const { store, res, run } = uploadRequest();
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    const competing: BeamStoredSession = {
      ...sampleUpload({ completed: true }),
      createdAt: 50,
      receivedAt: 75,
    };
    if (phase === "observation") {
      const observe = store.keyedStore.observe.getMockImplementation();
      assert(observe, "missing test observation");
      store.keyedStore.observe.mockImplementationOnce(async (key) => {
        entered.resolve();
        await resume.promise;
        return observe(key);
      });
    } else if (phase === "conflict") {
      const compare = store.keyedStore.compareAndApply.getMockImplementation();
      assert(compare, "missing test comparison");
      store.keyedStore.compareAndApply.mockImplementationOnce(async (...args) => {
        store.values.set(competing.beamId, competing);
        entered.resolve();
        await resume.promise;
        return compare(...args);
      });
    }
    const rejected = new Error("request owner rejected publication");
    const outcome = run().catch((error: unknown) => error);
    try {
      if (phase !== "current") {
        await expect(
          Promise.race([entered.promise.then(() => true), outcome.then(() => false)]),
          "request must reach the controlled checkpoint before finishing",
        ).resolves.toBe(true);
        requestScope.revalidate.mockImplementation(async () => {
          res.statusCode = 401;
          res.end();
          throw rejected;
        });
        resume.resolve();
      }
      expect(await outcome).toEqual(phase === "current" ? true : rejected);
      expect(res.statusCode).toBe(phase === "current" ? 200 : 401);
      expect(store.keyedStore.compareAndApply).toHaveBeenCalledTimes(
        phase === "observation" ? 0 : 1,
      );
      expect(await store.get(sampleUpload().beamId)).toEqual(
        phase === "current"
          ? { ...sampleUpload(), createdAt: 100, receivedAt: 100 }
          : phase === "observation"
            ? undefined
            : competing,
      );
    } finally {
      resume.resolve();
      await outcome;
    }
  },
);
