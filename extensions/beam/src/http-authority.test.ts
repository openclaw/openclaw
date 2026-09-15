import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { memoryStore, sampleUpload } from "./beam-store.test-support.js";
import { createBeamRequestHandler } from "./http.js";
import type { BeamStoredSession } from "./types.js";

const requestScope = vi.hoisted(() => ({ revalidate: vi.fn<() => Promise<void>>() }));
vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getPluginRuntimeGatewayRequestScope: () => requestScope,
}));

function uploadRequest(store: ReturnType<typeof memoryStore>) {
  const req = new IncomingMessage(new Socket());
  req.method = "POST";
  req.headers["content-type"] = "application/json";
  req.push(JSON.stringify(sampleUpload()));
  req.push(null);
  const res = new ServerResponse(req);
  const handler = createBeamRequestHandler({
    store,
    now: () => 100,
    resolveClient: () => ({ clientIp: "127.0.0.1", scopes: ["operator.write"] }),
    resolveControlUiBasePath: () => undefined,
  });
  return { req, res, run: () => handler(req, res) };
}

describe("Beam publisher authority continuation", () => {
  it("commits an upload while its request owner remains current", async () => {
    const store = memoryStore();
    const request = uploadRequest(store);
    requestScope.revalidate.mockReset().mockResolvedValue(undefined);
    try {
      expect(await request.run()).toBe(true);
      expect(request.res.statusCode).toBe(200);
      expect(await store.get(sampleUpload().beamId)).toEqual({
        ...sampleUpload(),
        createdAt: 100,
        receivedAt: 100,
      });
    } finally {
      request.req.destroy();
      request.res.destroy();
    }
  });

  it.each(["observation", "conflict"] as const)(
    "refuses an upload when its request owner rejects after %s",
    async (phase) => {
      const store = memoryStore();
      const entered = createDeferred<void>();
      const resume = createDeferred<void>();
      const competing: BeamStoredSession = {
        ...sampleUpload({ completed: true }),
        createdAt: 50,
        receivedAt: 75,
      };
      if (phase === "observation") {
        const observe = store.keyedStore.observe.getMockImplementation();
        if (!observe) {
          throw new Error("missing test observation");
        }
        store.keyedStore.observe.mockImplementationOnce(async (key) => {
          entered.resolve();
          await resume.promise;
          return observe(key);
        });
      } else {
        const compare = store.keyedStore.compareAndApply.getMockImplementation();
        if (!compare) {
          throw new Error("missing test comparison");
        }
        store.keyedStore.compareAndApply.mockImplementationOnce(async (...args) => {
          store.values.set(competing.beamId, competing);
          entered.resolve();
          await resume.promise;
          return compare(...args);
        });
      }
      const request = uploadRequest(store);
      let current = true;
      requestScope.revalidate.mockReset().mockImplementation(async () => {
        if (!current) {
          request.res.statusCode = 401;
          request.res.end();
          throw new Error("request owner rejected publication");
        }
      });
      const outcome = request.run().then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await Promise.race([
          entered.promise,
          outcome.then(() => {
            throw new Error("request finished before the controlled checkpoint");
          }),
        ]);
        current = false;
        resume.resolve();
        expect(await outcome).toEqual(new Error("request owner rejected publication"));
        expect(request.res.statusCode).toBe(401);
        expect(store.keyedStore.compareAndApply).toHaveBeenCalledTimes(
          phase === "observation" ? 0 : 1,
        );
        expect(await store.get(sampleUpload().beamId)).toEqual(
          phase === "observation" ? undefined : competing,
        );
      } finally {
        resume.resolve();
        await outcome;
        request.req.destroy();
        request.res.destroy();
      }
    },
  );
});
