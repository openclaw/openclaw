import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "40967" },
    samples: { type: "string", default: "100" },
    limit: { type: "string", default: "100" },
  },
});
const integer = (raw: string, label: string, min: number) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
const port = integer(values.port, "--port", 40000);
if (port > 65535) {
  throw new Error("--port must be between 40000 and 65535");
}
const samples = integer(values.samples, "--samples", 1);
const limit = integer(values.limit, "--limit", 1);
const client = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
try {
  await client.waitOpen();
  const request = async (method: string, params: unknown) => {
    const response = await client.request(method, params, 60_000);
    if (!response.ok) {
      throw new Error(`${method}: ${JSON.stringify(response.error)}`);
    }
    return response.payload;
  };
  await request("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: "gateway-client",
      displayName: "synthetic-fixture-measurement",
      version: "1.0.0",
      platform: process.platform,
      mode: "backend",
    },
    role: "operator",
    scopes: ["operator.read", "operator.admin"],
    caps: [],
  });
  const timings: number[] = [];
  let responseBytes = 0;
  let returnedSessions = 0;
  let totalSessions = 0;
  let firstCallMs = 0;
  // First call includes cold projection cost; five warmups precede steady-state samples.
  for (let index = 0; index < samples + 5; index++) {
    const start = performance.now();
    const result = await request("sessions.list", { limit, rowMode: "compact", archived: "all" });
    const elapsed = performance.now() - start;
    if (
      !result ||
      typeof result !== "object" ||
      !("count" in result) ||
      typeof result.count !== "number" ||
      !("totalCount" in result) ||
      typeof result.totalCount !== "number"
    ) {
      throw new Error("sessions.list returned no session counts");
    }
    returnedSessions = result.count;
    totalSessions = result.totalCount;
    if (index === 0) {
      firstCallMs = elapsed;
    }
    if (index >= 5) {
      timings.push(elapsed);
      responseBytes = Buffer.byteLength(JSON.stringify(result));
    }
  }
  timings.sort((left, right) => left - right);
  const percentile = (fraction: number) => timings[Math.ceil(timings.length * fraction) - 1];
  console.log(
    JSON.stringify(
      {
        method: "sessions.list",
        transport: "loopback WebSocket; one operator connection; compact rows; archived=all",
        samples,
        limit,
        firstCallMs,
        meanMs: timings.reduce((sum, value) => sum + value, 0) / timings.length,
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        p99Ms: percentile(0.99),
        responseBytes,
        returnedSessions,
        totalSessions,
      },
      null,
      2,
    ),
  );
} finally {
  client.close();
}
