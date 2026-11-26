// Synthetic constructor + initial-context proof. See --help options in parseArgs below.
// Run five counterbalanced A1/A2/B groups; baseline files are saved from the same parent.
// Accept only identical context bytes, less allocation and CPU than both A arms,
// and no material wall-time regression. No database, workspace I/O or model call.
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { registerPerfOwnerReplacement } from "../lib/perf-owner-replacement.ts";

const { values } = parseArgs({
  options: {
    "codec-file": { type: "string" },
    "snapshot-file": { type: "string" },
    entries: { type: "string", default: "4000" },
    iterations: { type: "string", default: "100" },
    warmup: { type: "string", default: "20" },
    output: { type: "string" },
    "max-owner-bytes": { type: "string" },
  },
});
const entries = Number(values.entries);
const iterations = Number(values.iterations);
const warmup = Number(values.warmup);
for (const count of [entries, iterations, warmup]) {
  assert(Number.isSafeInteger(count) && count > 0);
}
assert(entries % 4 === 0, "--entries must contain complete four-message turns");
const codecUrl = new URL("../../src/agents/sessions/session-manager-codec.ts", import.meta.url);
const snapshotUrl = new URL("../../src/config/sessions/transcript-snapshot.ts", import.meta.url);
const codecLoaded = registerPerfOwnerReplacement(codecUrl.href, values["codec-file"]);
const snapshotLoaded = registerPerfOwnerReplacement(snapshotUrl.href, values["snapshot-file"]);
const { buildInitialContext } = await import("../../src/agents/sessions/session-manager-codec.js");
const { SessionManager } = await import("../../src/agents/sessions/session-manager.js");
const currentTurn = await import("../../src/agents/sessions/session-manager-current-turn.js");
const { freezeTrustedJsonSnapshot } = await import("../../src/shared/immutable-data.js");
assert(!values["codec-file"] || codecLoaded());
assert(!values["snapshot-file"] || snapshotLoaded());
const timestamp = "2026-11-17T00:00:00.000Z";
const fixture: unknown[] = [
  { type: "session", version: 4, id: "synthetic", cwd: "/synthetic", timestamp },
];
for (let turn = 0; turn < entries / 4; turn++) {
  const assistant = {
    api: "openai-responses",
    provider: "openai",
    model: "synthetic",
    timestamp: turn,
  };
  const messages = [
    { role: "user", content: `Synthetic question ${turn}`, timestamp: turn },
    {
      ...assistant,
      role: "assistant",
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: `call-${turn}`,
          name: "read",
          arguments: { path: `file-${turn}`, options: { lines: [1, 200] } },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: `call-${turn}`,
      toolName: "read",
      content: [{ type: "text", text: `Synthetic ${turn}:`.padEnd(2048, "x") }],
      details: { rows: [{ line: 1, value: "private evidence" }] },
      isError: false,
      timestamp: turn,
    },
    {
      ...assistant,
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: `Synthetic answer ${turn}` }],
    },
  ];
  for (const message of messages) {
    const index = fixture.length;
    fixture.push({
      type: "message",
      id: `entry-${index}`,
      parentId: index === 1 ? null : `entry-${index - 1}`,
      timestamp,
      message,
    });
  }
}
const branch = SessionManager.fromEntries(fixture).getBranch();
const frozenBranch = freezeTrustedJsonSnapshot(structuredClone(branch));
const expected = JSON.stringify(buildInitialContext(branch));
const outputHash = hash("sha256", expected);
const loadBefore = loadavg();
const results = [];
for (const mode of ["construction", "mutable-owner", "frozen-owner"] as const) {
  const operation = async () =>
    mode === "construction"
      ? SessionManager.fromEntries(fixture)[currentTurn.sessionManagerReadInitialContext]()
      : buildInitialContext(mode === "mutable-owner" ? branch : frozenBranch);
  for (let index = 0; index < warmup; index++) {
    await operation();
  }
  const latencies = new Float64Array(iterations);
  const allocatedBefore = getHeapStatistics().total_allocated_bytes;
  assert(Number.isFinite(allocatedBefore), "Requires V8 total_allocated_bytes");
  const cpuBefore = process.threadCpuUsage();
  let latest;
  for (let index = 0; index < iterations; index++) {
    const started = performance.now();
    latest = await operation();
    latencies[index] = performance.now() - started;
  }
  const cpu = process.threadCpuUsage(cpuBefore);
  const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocatedBefore;
  assert.equal(JSON.stringify(latest), expected, "Model-context bytes changed");
  const sorted = latencies.toSorted();
  const bytesPerOperation = allocatedBytes / iterations;
  results.push({
    mode,
    bytesPerOperation,
    cpuMsPerOperation: (cpu.user + cpu.system) / 1000 / iterations,
    medianMs: sorted[Math.floor(iterations / 2)],
    p95Ms: sorted[Math.ceil(iterations * 0.95) - 1],
    minMs: sorted[0],
    maxMs: sorted.at(-1),
  });
  if (mode === "mutable-owner" && values["max-owner-bytes"]) {
    assert(
      bytesPerOperation <= Number(values["max-owner-bytes"]),
      `Owner allocation budget exceeded: ${bytesPerOperation}`,
    );
  }
}
const report = {
  entries,
  iterations,
  warmup,
  fixtureBytes: Buffer.byteLength(JSON.stringify(fixture)),
  outputHash,
  codecHash: hash("sha256", readFileSync(values["codec-file"] ?? codecUrl)),
  snapshotHash: hash("sha256", readFileSync(values["snapshot-file"] ?? snapshotUrl)),
  node: process.version,
  loadBefore,
  loadAfter: loadavg(),
  results,
};
const json = `${JSON.stringify(report, null, 2)}\n`;
if (values.output) {
  writeFileSync(values.output, json);
}
console.log(json);
