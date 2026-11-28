/**
 * SessionManager load boundary: 32 retained, owner-frozen histories exceed the
 * generic freezer's admission memo. Each has 512 tool results x 16 4-KiB blocks.
 * node --import ./scripts/tsx.mjs scripts/perf/session-load-inspect-measure.ts \
 *   --mode timing --iterations 3000
 * Repeat with --mode allocation (16 KiB sampling), --mode counts, and --sessions 1
 * for the warm control. Alternate revisions; --codec-file accepts a saved base
 * codec at its original module URL. --profile writes the sampling heap profile;
 * --sampling-interval 1024 gives fine leaf attribution in a shorter pass.
 * Counts instrument fixture own-key/descriptor reads only; timing is untraced.
 * Fixture creation/freezing and warmup are outside measurement. No Gateway/DB IO.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "codec-file": { type: "string" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "3000" },
    sessions: { type: "string", default: "32" },
    entries: { type: "string", default: "512" },
    profile: { type: "string" },
    "sampling-interval": { type: "string", default: "16384" },
  },
});
const iterations = Number(values.iterations);
const sessionCount = Number(values.sessions);
const entryCount = Number(values.entries);
const samplingInterval = Number(values["sampling-interval"]);
for (const value of [iterations, sessionCount, entryCount, samplingInterval]) {
  assert(Number.isSafeInteger(value) && value > 0);
}
assert(["timing", "allocation", "counts"].includes(values.mode));
const codecUrl = new URL("../../src/agents/sessions/session-manager-codec.ts", import.meta.url);
const codecSource = readFileSync(values["codec-file"] ?? codecUrl, "utf8");
const hooks = values["codec-file"]
  ? registerHooks({
      load(url, context, next) {
        return url === codecUrl.href
          ? { format: "module", source: stripTypeScriptTypes(codecSource), shortCircuit: true }
          : next(url, context);
      },
    })
  : undefined;
const { SessionManagerCore } = await import("../../src/agents/sessions/session-manager-core.js");
const { freezeTranscriptSnapshot } =
  await import("../../src/config/sessions/transcript-snapshot.js");
hooks?.deregister();
const text = "synthetic tool result ".repeat(196);
const fixtures = Array.from({ length: sessionCount }, (_, session) => {
  const events = [
    { type: "session", version: 4, id: `session-${session}`, cwd: "/synthetic" },
    ...Array.from({ length: entryCount }, (_entry, entry) => ({
      type: "message",
      id: `entry-${entry}`,
      parentId: entry === 0 ? null : `entry-${entry - 1}`,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "toolResult",
        toolCallId: `call-${entry}`,
        toolName: "read",
        isError: false,
        timestamp: 0,
        content: Array.from({ length: 16 }, () => ({ type: "text", text })),
      },
    })),
  ];
  return freezeTranscriptSnapshot({
    events,
    version: { generation: `generation-${session}`, rawSeq: entryCount, updatedAt: 1 },
  });
});
const owned = new WeakSet<object>();
let fixtureObjects = 0;
const collect = (value: unknown): void => {
  if (!value || typeof value !== "object" || owned.has(value)) {
    return;
  }
  owned.add(value);
  fixtureObjects++;
  for (const child of Object.values(value)) {
    collect(child);
  }
};
for (const fixture of fixtures) {
  collect(fixture.events);
}
const run = (count: number) => {
  for (let index = 0; index < count; index++) {
    const fixture = fixtures[index % fixtures.length]!;
    const manager = new SessionManagerCore("/synthetic", undefined, fixture.events);
    assert.equal(manager.getLeafId(), `entry-${entryCount - 1}`);
  }
};
run(sessionCount * 2);
let inspectedObjects = 0;
let inspectedProperties = 0;
const ownKeys = Reflect.ownKeys;
const descriptor = Object.getOwnPropertyDescriptor;
if (values.mode === "counts") {
  Reflect.ownKeys = (target) => {
    if (owned.has(target)) {
      inspectedObjects++;
    }
    return ownKeys(target);
  };
  Object.getOwnPropertyDescriptor = (target, key) => {
    if (owned.has(target)) {
      inspectedProperties++;
    }
    return descriptor(target, key);
  };
}
const inspector = new Session();
let allocatedBytes: number | undefined;
if (values.mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
try {
  const loadStart = loadavg();
  const cpuStart = process.threadCpuUsage();
  const start = performance.now();
  run(iterations);
  const wallMs = performance.now() - start;
  const cpu = process.threadCpuUsage(cpuStart);
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    allocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    if (values.profile) {
      writeFileSync(values.profile, JSON.stringify(profile));
    }
  }
  console.log(
    JSON.stringify({
      mode: values.mode,
      iterations,
      sessionCount,
      entryCount,
      fixtureObjects,
      samplingInterval,
      codecSha256: createHash("sha256").update(codecSource).digest("hex"),
      wallMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      cpuUsPerLoad: (cpu.user + cpu.system) / iterations,
      allocatedBytesPerLoad: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
      ...(values.mode === "counts"
        ? {
            inspectedObjectsPerLoad: inspectedObjects / iterations,
            inspectedPropertiesPerLoad: inspectedProperties / iterations,
          }
        : {}),
      loadStart,
      loadEnd: loadavg(),
      memory: process.memoryUsage(),
    }),
  );
} finally {
  Reflect.ownKeys = ownKeys;
  Object.getOwnPropertyDescriptor = descriptor;
  inspector.disconnect();
}
