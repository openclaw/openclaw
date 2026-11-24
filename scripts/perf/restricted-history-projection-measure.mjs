// Run with node --expose-gc --import ./scripts/tsx.mjs scripts/perf/restricted-history-projection-measure.mjs
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import os from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { encodeChatHistoryResponsePage } from "../../src/gateway/chat-history-response-page.js";
import { projectOperatorModelRead } from "../../src/gateway/operator-model-presentation.js";
import { SerializedJsonArray, serializeGatewayFrame } from "../../src/gateway/serialized-json.js";
import {
  gatewayConnect,
  gatewayProfile,
} from "../../src/gateway/server/client-fixtures.test-support.js";

// Optional baseline encoder source, materialized beside its original relative imports.
const baselineEncoder = process.argv[2]
  ? (await import(pathToFileURL(resolve(process.argv[2])).href)).encodeChatHistoryResponsePage
  : undefined;
const cfg = {
  agents: {
    defaults: { model: "example/allowed", models: { "example/allowed": {}, "example/hidden": {} } },
    entries: { main: {} },
  },
  plugins: { enabled: false },
  gateway: {
    roles: {
      default: "reader",
      definitions: {
        reader: {
          agents: ["main"],
          scopes: ["operator.read"],
          sessions: { others: "view" },
          modelPolicy: { sourceAgent: "main", allow: ["example/allowed"] },
        },
      },
    },
  },
};
const scope = {
  context: { getRuntimeConfig: () => cfg, getCommittedRuntimeConfig: () => cfg },
  client: {
    connect: gatewayConnect(["operator.read"]),
    authenticatedUserProfile: gatewayProfile("synthetic-reader"),
    preparedSessionProfile: {
      profileId: "synthetic-reader",
      aliases: new Set(["synthetic-reader"]),
      role: null,
    },
  },
  agentId: "main",
};
const params = {
  encodeResponse: true,
  entry: undefined,
  provider: "example",
  sessionId: "synthetic",
  storePath: undefined,
  sessionAgentId: "main",
  canonicalKey: "agent:main:synthetic",
  max: 200,
  maxHistoryBytes: 512 * 1024,
  responseHistoryBytes: 512 * 1024,
  effectiveMaxChars: 20_000,
  offset: undefined,
  messageId: undefined,
};
const cases = [0, 5, 100].map((percent) => {
  const rows = Array.from({ length: 200 }, (_, i) => ({
    role: "assistant",
    ...(i < percent * 2 ? { provider: "example", model: "hidden" } : {}),
    content: [{ type: "text", text: "Synthetic transcript line with Unicode 雪. ".repeat(30) }],
    __openclaw: { id: `message-${i}`, seq: i + 1 },
  }));
  const page = encodeChatHistoryResponsePage({ messages: rows }, params);
  assert(page.encodedResponse);
  const bytes = page.encodedResponse.messages;
  const baseline = { kind: "snapshot", messages: new SerializedJsonArray(bytes) };
  const candidate = {
    kind: "snapshot",
    messages: new SerializedJsonArray(bytes, page.messageModelIndex),
  };
  const frame = (input) =>
    serializeGatewayFrame({
      type: "res",
      id: "history",
      ok: true,
      payload: projectOperatorModelRead(scope, input),
    });
  assert.equal(frame(candidate).toString(), frame(baseline).toString());
  assert.equal(candidate.messages.materialize().length, 200);
  return { percent, rows, baseline, candidate, frame, bytes: bytes.byteLength };
});
let sink = 0;
const run = (item, label, metric = "projection") => {
  if (metric === "encoding") {
    const encode = label === "B" ? encodeChatHistoryResponsePage : baselineEncoder;
    sink += encode({ messages: item.rows }, params).encodedResponse.messages.byteLength;
    return;
  }
  const frame = item.frame(label === "B" ? item.candidate : item.baseline);
  sink += typeof frame === "string" ? Buffer.from(frame).byteLength : frame.byteLength;
};
const inspector = new Session();
inspector.connect();
const allocated = (node) =>
  node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
console.log(
  JSON.stringify({
    node: process.version,
    platform: os.platform(),
    cpu: os.cpus()[0].model,
    load: os.loadavg(),
    note: "A/A2 use the retained full-materialization path; B uses the worker index. Projection excludes producer; optional baseline module enables separate encoding comparison.",
  }),
);
for (const item of cases) {
  for (const label of ["A", "B"]) {
    for (let i = 0; i < 300; i++) {
      run(item, label);
    }
  }
}
for (const metric of baselineEncoder ? ["projection", "encoding"] : ["projection"]) {
  for (let pair = 0; pair < 5; pair++) {
    for (const item of cases) {
      for (const label of pair % 2 ? ["B", "A2", "A"] : ["A", "A2", "B"]) {
        global.gc?.();
        const cpuStart = process.cpuUsage();
        const wallStart = performance.now();
        for (let i = 0; i < 1000; i++) {
          run(item, label, metric);
        }
        const wallUs = performance.now() - wallStart;
        const cpu = process.cpuUsage(cpuStart);
        global.gc?.();
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 8192,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
        for (let i = 0; i < 250; i++) {
          run(item, label, metric);
        }
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        console.log(
          JSON.stringify({
            metric,
            pair,
            percent: item.percent,
            label,
            bytes: item.bytes,
            cpuUs: (cpu.user + cpu.system) / 1000,
            wallUs,
            allocatedBytes: allocated(profile.head) / 250,
          }),
        );
      }
    }
  }
}
inspector.disconnect();
console.log(JSON.stringify({ sink, load: os.loadavg() }));
