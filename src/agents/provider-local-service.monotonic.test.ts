import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfiguredProviderLocalServiceAcquirer } from "./provider-local-service.js";
import { createProviderLocalServiceTestFixture } from "./provider-local-service.test-support.js";

describe("provider readiness wait clock domain", () => {
  const fixture = createProviderLocalServiceTestFixture();
  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture.cleanup();
  });

  it.each([-10 * 60_000, 10 * 60_000])(
    "keeps the readiness deadline when the wall clock steps %i ms",
    async (offset) => {
      // Everything runs on real time: the spawned child process, its real HTTP
      // health endpoint, the probes, and the readiness sleeps. Only the wall
      // clock reading is stepped mid-wait, like an NTP correction or VM resume.
      const wallNow = Date.now.bind(Date);
      const wallClock = vi.spyOn(Date, "now");
      const realFetch = globalThis.fetch;
      let steppedAt: number | undefined;
      let confirmProbe!: () => void;
      const firstProbe = new Promise<void>((resolve) => {
        confirmProbe = resolve;
      });
      vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
        const response = await realFetch(...args);
        if (response.status === 503 && steppedAt === undefined) {
          steppedAt = performance.now();
          wallClock.mockImplementation(() => wallNow() + offset);
          confirmProbe();
        }
        return response;
      });
      const port = await fixture.claimPort();
      const baseUrl = `http://127.0.0.1:${port}/v1`;
      const acquire = createConfiguredProviderLocalServiceAcquirer(() => ({
        models: {
          providers: {
            "local-never-ready": {
              baseUrl,
              models: [],
              localService: {
                // A real local service whose /models health endpoint never turns healthy.
                command: process.execPath,
                args: [
                  "-e",
                  `const http=require("http");http.createServer((req,res)=>{res.writeHead(503);res.end("booting")}).listen(${port},"127.0.0.1");`,
                ],
                readyTimeoutMs: 3_000,
                idleStopMs: 1,
              },
            },
          },
        },
      }));
      const target = {
        providerId: "local-never-ready",
        baseUrl,
        reconcile: async () => {},
      };
      let settled = false;
      const outcome = acquire(target).then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      // A real unhealthy response occurs inside the readiness loop, after its
      // deadline was established. Keep wall time advancing after the step.
      await firstProbe;
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
      expect(settled).toBe(false);
      expect(await outcome).toEqual(
        expect.objectContaining({
          message: expect.stringContaining("local-never-ready local service did not become ready"),
        }),
      );
      expect(performance.now() - steppedAt!).toBeGreaterThan(2_000);
      expect(performance.now() - steppedAt!).toBeLessThan(8_000);
      wallClock.mockRestore();
    },
    10_000,
  );
});
