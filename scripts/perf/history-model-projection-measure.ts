/**
 * Warm initial-history model projection and response serialization, with 65 viewers.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/history-model-projection-measure.ts
 * Add --allocations for a separate sampling pass that includes collected objects;
 * use the uninstrumented run for CPU. Run the same script on base and candidate.
 * Five passes of 650 responses follow warmup. The 80-message window is ~256 KiB,
 * including tool calls/results; prepared viewer profiles avoid database work.
 * Acceptance: identical authorized wire bytes, fewer history materializations,
 * and lower CPU/allocation per response. This is an owner microbenchmark, not
 * whole-Gateway latency proof. Encoded response segments stay unflattened while timed.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { projectOperatorModelRead } from "../../src/gateway/operator-model-presentation.js";
import { SerializedJsonArray, serializeGatewayFrame } from "../../src/gateway/serialized-json.js";
import type { GatewayClient } from "../../src/gateway/server-methods/types.js";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";

const { values } = parseArgs({
  options: { allocations: { type: "boolean", default: false } },
});
const cfg: OpenClawConfig = {
  agents: { entries: { main: {} } },
  plugins: { enabled: false },
  gateway: {
    roles: {
      default: "reader",
      definitions: {
        reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
        granted: {
          agents: "*",
          scopes: ["operator.read"],
          sessions: { others: "view" },
          accessPrograms: { cyber: ["daybreak_blue"] },
        },
      },
    },
  },
};
const context = { getRuntimeConfig: () => cfg, getCommittedRuntimeConfig: () => cfg };
const viewers = Array.from({ length: 65 }, (_, index) => {
  const profileId = `synthetic-viewer-${index}`;
  const granted = index % 2 === 0;
  const client: GatewayClient = {
    connId: profileId,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "synthetic",
        platform: "synthetic",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.read"],
      caps: ["ultrafast"],
    },
    internal: { operatorRoleActor: { kind: "operator", profileId } },
    preparedSessionProfile: {
      profileId,
      role: granted ? "granted" : "reader",
      aliases: new Set([profileId]),
    },
  };
  return { client, granted };
});
const messages = Array.from({ length: 80 }, (_, index) => {
  const text = `Synthetic transcript ${index}: ${"bounded history content ".repeat(134)}`;
  switch (index % 4) {
    case 0:
      return { role: "user", content: [{ type: "text", text }] };
    case 1:
      return {
        role: "assistant",
        provider: "fixture-0",
        model: "model-0",
        content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: { text } }],
      };
    case 2:
      return {
        role: "toolResult",
        toolCallId: `call-${index - 1}`,
        content: [{ type: "text", text }],
      };
    default:
      return {
        role: "assistant",
        provider: "fixture-0",
        model: "model-0",
        content: [{ type: "text", text }],
      };
  }
});
let materializations = 0;
class CountedHistoryArray extends SerializedJsonArray {
  override materialize(): unknown[] {
    materializations++;
    return super.materialize();
  }
}
const historyBytes = Buffer.from(JSON.stringify(messages));
const input = {
  sessionKey: "agent:main:synthetic-history",
  sessionId: "synthetic-history",
  defaults: { model: "model-0", modelProvider: "fixture-0", contextTokens: 128_000 },
  metadata: { swarmEnabled: false, commands: [] },
  messages: new CountedHistoryArray(historyBytes),
};
const envelope = (payload: unknown) => ({
  type: "res",
  id: "synthetic-subscribe",
  ok: true,
  payload: {
    subscribed: true,
    key: input.sessionKey,
    agentId: "main",
    initialHistory: { ok: true, payload },
  },
});
const prepare = (client: GatewayClient) =>
  serializeGatewayFrame(
    envelope(projectOperatorModelRead({ context, client, agentId: "main" }, input)),
  );
// Verify every viewer outside measurement; serialization itself is the measured boundary.
for (const { client } of viewers) {
  const expected = JSON.stringify(envelope({ ...input, messages }));
  const actual = prepare(client);
  assert.equal(typeof actual === "string" ? actual : actual.toString(), expected);
}
function run(rounds: number): number {
  let wireBytes = 0;
  for (let round = 0; round < rounds; round++) {
    for (const { client } of viewers) {
      const frame = prepare(client);
      wireBytes += typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength;
    }
  }
  return wireBytes;
}
run(2);
const inspector = new Session();
const operationsPerPass = viewers.length * 10;
const samples = [];
if (values.allocations) {
  inspector.connect();
}
try {
  for (let pass = 0; pass < 5; pass++) {
    globalThis.gc?.();
    if (values.allocations) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const hostLoadBefore = loadavg();
    const memoryBefore = process.memoryUsage();
    const initialMaterializations = materializations;
    const cpu = process.threadCpuUsage();
    const start = performance.now();
    const wireBytes = run(10);
    const elapsedMs = performance.now() - start;
    const used = process.threadCpuUsage(cpu);
    const memoryAfter = process.memoryUsage();
    const allocationBytes = values.allocations
      ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
      : undefined;
    samples.push({
      operations: operationsPerPass,
      elapsedMs,
      cpuMsPerOperation: (used.user + used.system) / 1000 / operationsPerPass,
      allocatedBytesPerOperation:
        allocationBytes === undefined ? undefined : allocationBytes / operationsPerPass,
      wireBytesPerOperation: wireBytes / operationsPerPass,
      materializationsPerOperation:
        (materializations - initialMaterializations) / operationsPerPass,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
      memoryBefore,
      memoryAfter,
    });
  }
  console.log(
    JSON.stringify({
      mode: values.allocations ? "allocation" : "timing",
      node: process.version,
      viewers: viewers.length,
      messages: messages.length,
      historyBytes: historyBytes.byteLength,
      operations: operationsPerPass * samples.length,
      wireEquality: true,
      samples,
    }),
  );
} finally {
  if (values.allocations) {
    inspector.disconnect();
  }
}
