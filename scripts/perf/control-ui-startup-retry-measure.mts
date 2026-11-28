// node --import ./scripts/tsx.mjs scripts/perf/control-ui-startup-retry-measure.mts [owner-module]
// Thirty connections, four startup reads, 13 seconds unavailable; no handler/DB work.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { mock } from "node:test";
import { pathToFileURL } from "node:url";
import type { GatewayPendingRequests as PendingRequests } from "../../packages/gateway-client/src/pending-request.js";

const { GatewayPendingRequests } = (await import(
  process.argv[2]
    ? pathToFileURL(process.argv[2]).href
    : "../../packages/gateway-client/src/pending-request.ts"
)) as { GatewayPendingRequests: typeof PendingRequests };
const methods = ["mentions.list", "sessions.github.options", "models.list", "tools.effective"];

async function wave() {
  let now = 0;
  let count = 0;
  let refused = 0;
  let ready = false;
  const results: Promise<unknown>[] = [];
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    for (let client = 0; client < 30; client++) {
      const requests = new GatewayPendingRequests({
        createRequestId: () => "synthetic",
        nowMs: () => now,
      });
      const sender = {
        send(raw: string) {
          const frame = JSON.parse(raw) as { id: string; method: string };
          count++;
          if (!ready) {
            refused++;
          }
          // Include the Gateway response's wire encoding and client decoding.
          const response = JSON.stringify(
            ready
              ? { type: "res", id: frame.id, ok: true, payload: { ready: true } }
              : {
                  type: "res",
                  id: frame.id,
                  ok: false,
                  error: {
                    code: "UNAVAILABLE",
                    message: `${frame.method} unavailable during gateway startup`,
                    retryable: true,
                    retryAfterMs: 500,
                    details: { reason: "startup-sidecars", method: frame.method },
                  },
                },
          );
          requests.handleResponse(JSON.parse(response));
        },
      };
      for (const method of methods) {
        results.push(requests.request(sender, method, { agentId: "synthetic" }));
      }
    }
    // Visit every possible retry boundary; ticking once would skip elapsed work.
    while (now < 13_000) {
      now += 500;
      mock.timers.tick(500);
    }
    ready = true;
    while (now < 21_000) {
      now += 500;
      mock.timers.tick(500);
    }
    assert.equal((await Promise.all(results)).length, 120);
    return { requests: count, refused };
  } finally {
    mock.timers.reset();
  }
}

await wave();
const inspector = new Session();
inspector.connect();
try {
  for (const mode of ["timing", "allocation"] as const) {
    if (mode === "allocation") {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const cpu = process.cpuUsage();
    const start = performance.now();
    let counts;
    for (let repetition = 0; repetition < 100; repetition++) {
      counts = await wave();
    }
    const elapsedMs = performance.now() - start;
    const usage = process.cpuUsage(cpu);
    let allocationBytes;
    if (mode === "allocation") {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      allocationBytes = profile.samples.reduce((total, sample) => total + sample.size, 0);
    }
    console.log(
      JSON.stringify({
        mode,
        waves: 100,
        ...counts,
        elapsedMs,
        cpuMs: (usage.user + usage.system) / 1000,
        allocationBytes,
      }),
    );
  }
} finally {
  inspector.disconnect();
}
