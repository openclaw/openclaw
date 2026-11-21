import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfiguredProviderLocalServiceAcquirer } from "./provider-local-service.js";
import { createProviderLocalServiceTestFixture } from "./provider-local-service.test-support.js";

describe("provider readiness wait clock domain", () => {
  const fixture = createProviderLocalServiceTestFixture();
  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture.cleanup();
  });

  it("fails the readiness wait at its monotonic deadline when the wall clock rewinds", async () => {
    // Everything runs on real time: the spawned child process, its real HTTP
    // health endpoint, the probes, and the readiness sleeps. Only the wall
    // clock reading is rewound mid-wait, like an NTP correction or VM resume.
    const startedAt = Date.now();
    const wallClock = vi.spyOn(Date, "now");
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
    let rewound = false;
    const target = {
      providerId: "local-never-ready",
      baseUrl,
      // The wait hook fires once the readiness wait starts after the first
      // real probe: rewind the wall clock from inside the real wait.
      onReadinessWait: (waiting: boolean) => {
        if (waiting && !rewound) {
          rewound = true;
          wallClock.mockReturnValue(startedAt - 10 * 60_000);
        }
      },
      reconcile: async () => {},
    };
    await expect(acquire(target)).rejects.toThrow(
      "local-never-ready local service did not become ready",
    );
    expect(rewound).toBe(true);
    wallClock.mockRestore();
  });
});
